import { createHmac, timingSafeEqual } from 'crypto';

const SIGNATURE_FORMAT = /^[A-Za-z0-9+/]{43}=$/;
const TIMESTAMP_FORMAT =
	/^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

/** Why a delivery was rejected. Internal: every reason produces the same 401. */
export type RejectionReason =
	| 'missing-field'
	| 'header-mismatch'
	| 'malformed-signature'
	| 'key-id-mismatch'
	| 'bad-mac'
	| 'bad-timestamp';

export interface DeliveryToVerify {
	body: unknown;
	signatureHeader: unknown;
	secret: unknown;
	keyId: unknown;
	nowMs: number;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return Object.prototype.toString.call(value) === '[object Object]';
}

/**
 * RFC 8785 (JCS) serialization of a parsed JSON value.
 *
 * Numbers and strings use `JSON.stringify`, which is what the RFC specifies and
 * what Evinor's signer does. Keys sort by UTF-16 code unit (the default `sort`),
 * and `Object.keys` keeps an own `__proto__` key produced by `JSON.parse`.
 */
export function canonicalizeJcs(value: unknown): string {
	if (value === null || typeof value === 'boolean' || typeof value === 'string') {
		return JSON.stringify(value);
	}
	if (typeof value === 'number') {
		if (!Number.isFinite(value)) {
			throw new TypeError('JCS cannot represent a non-finite number');
		}
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) {
		return `[${value.map((element) => canonicalizeJcs(element)).join(',')}]`;
	}
	if (isPlainObject(value)) {
		const members = Object.keys(value)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonicalizeJcs(value[key])}`);
		return `{${members.join(',')}}`;
	}
	throw new TypeError('JCS input is not JSON data');
}

/** The UTF-8 bytes Evinor signs: the envelope minus `sender.signature` only. */
export function signedBytes(envelope: Record<string, unknown>): Buffer {
	const copy = structuredClone(envelope);
	delete (copy.sender as Record<string, unknown>).signature;
	return Buffer.from(canonicalizeJcs(copy), 'utf8');
}

function isTimestampFresh(timestamp: string, nowMs: number): boolean {
	const match = TIMESTAMP_FORMAT.exec(timestamp);
	if (match === null) {
		return false;
	}
	const [, year, month, day] = match;
	// V8 rolls an impossible day such as Feb 31 forward instead of rejecting it.
	const lastDayOfMonth = new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate();
	if (Number(day) < 1 || Number(day) > lastDayOfMonth) {
		return false;
	}
	const parsedMs = Date.parse(timestamp);
	return !Number.isNaN(parsedMs) && Math.abs(nowMs - parsedMs) <= MAX_CLOCK_SKEW_MS;
}

/**
 * Applies the ordered checks and names the first one that fails, or returns
 * `null` for an authentic delivery. Can throw on hostile input (for example
 * very deep nesting); callers outside tests use `isAuthenticDelivery`.
 */
export function findRejectionReason(delivery: DeliveryToVerify): RejectionReason | null {
	const { body, signatureHeader, secret, keyId, nowMs } = delivery;

	if (
		typeof secret !== 'string' ||
		secret.trim().length === 0 ||
		!isPlainObject(body) ||
		!isPlainObject(body.sender)
	) {
		return 'missing-field';
	}
	const { keyId: senderKeyId, signature } = body.sender;
	const { timestamp } = body;
	if (
		typeof senderKeyId !== 'string' ||
		typeof signature !== 'string' ||
		typeof timestamp !== 'string'
	) {
		return 'missing-field';
	}

	if (signatureHeader !== signature) {
		return 'header-mismatch';
	}

	// Buffer.from(x, 'base64') silently drops invalid characters, so the format
	// is enforced before decoding.
	if (!SIGNATURE_FORMAT.test(signature)) {
		return 'malformed-signature';
	}
	// The final character carries unused bits, so several spellings decode alike.
	if (Buffer.from(signature, 'base64').toString('base64') !== signature) {
		return 'malformed-signature';
	}

	if (senderKeyId !== keyId) {
		return 'key-id-mismatch';
	}

	// n8n hands over the parsed body, so the signed form is rebuilt from it; the
	// raw request bytes are never hashed.
	const expected = createHmac('sha256', secret).update(signedBytes(body)).digest();
	if (!timingSafeEqual(expected, Buffer.from(signature, 'base64'))) {
		return 'bad-mac';
	}

	return isTimestampFresh(timestamp, nowMs) ? null : 'bad-timestamp';
}

/** True only for an authentic, fresh delivery. Never throws. */
export function isAuthenticDelivery(delivery: DeliveryToVerify): boolean {
	try {
		return findRejectionReason(delivery) === null;
	} catch {
		return false;
	}
}
