// Task 2.3: JCS canonicalizer and HMAC verifier (design Decision 4).
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import verifier from '../dist/nodes/EvinorTrigger/verifier.js';

const { canonicalizeJcs, findRejectionReason, isAuthenticDelivery, signedBytes } = verifier;

const load = (name) =>
	JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));

const golden = load('golden-envelope.json');
const goldenTest = load('golden-test-envelope.json');
const NOW = Date.parse(golden.clock);

const goldenDelivery = (overrides = {}) => ({
	body: structuredClone(golden.envelope),
	signatureHeader: golden.envelope.sender.signature,
	secret: golden.secret,
	keyId: golden.keyId,
	nowMs: NOW,
	...overrides,
});

// Signs like Evinor, so a failing case reaches the step it targets instead of
// tripping over a stale signature in an earlier one.
function signedDelivery(mutate, overrides = {}) {
	const body = structuredClone(golden.envelope);
	mutate(body);
	const signature = createHmac('sha256', golden.secret).update(signedBytes(body)).digest('base64');
	body.sender.signature = signature;
	return goldenDelivery({ body, signatureHeader: signature, ...overrides });
}

function assertRejected(delivery, reason) {
	assert.equal(findRejectionReason(delivery), reason);
	assert.equal(isAuthenticDelivery(delivery), false);
}

describe('task 2.3: golden fixtures', () => {
	it('verifies the golden envelope signed by Evinor', () => {
		assert.equal(findRejectionReason(goldenDelivery()), null);
		assert.equal(isAuthenticDelivery(goldenDelivery()), true);
	});

	it('verifies the golden test-delivery envelope (incident-rule-test)', () => {
		const delivery = {
			body: structuredClone(goldenTest.envelope),
			signatureHeader: goldenTest.envelope.sender.signature,
			secret: goldenTest.secret,
			keyId: goldenTest.keyId,
			nowMs: Date.parse(goldenTest.clock),
		};
		assert.equal(goldenTest.envelope.recipients.kind, 'incident-rule-test');
		assert.equal(findRejectionReason(delivery), null);
	});

	it('does not mutate the parsed body it verifies', () => {
		const delivery = goldenDelivery();
		isAuthenticDelivery(delivery);
		assert.deepEqual(delivery.body, golden.envelope);
	});
});

describe('task 2.3: step 1, absent secret or fields', () => {
	const cases = [
		['absent secret', goldenDelivery({ secret: undefined })],
		['empty secret', goldenDelivery({ secret: '' })],
		['whitespace-only secret', goldenDelivery({ secret: ' \t\n ' })],
		['null body', goldenDelivery({ body: null })],
		['array body', goldenDelivery({ body: [golden.envelope] })],
		['string body', goldenDelivery({ body: 'envelope' })],
		['absent sender', signedOmit((body) => delete body.sender)],
		['array sender', signedOmit((body) => (body.sender = []))],
		['null sender', signedOmit((body) => (body.sender = null))],
		['absent sender.keyId', signedOmit((body) => delete body.sender.keyId)],
		['non-string sender.keyId', signedOmit((body) => (body.sender.keyId = 7))],
		['absent sender.signature', signedOmit((body) => delete body.sender.signature)],
		['non-string sender.signature', signedOmit((body) => (body.sender.signature = 7))],
		['absent timestamp', signedOmit((body) => delete body.timestamp)],
		['non-string timestamp', signedOmit((body) => (body.timestamp = 1775044800000))],
	];

	function signedOmit(mutate) {
		const body = structuredClone(golden.envelope);
		mutate(body);
		return goldenDelivery({ body });
	}

	for (const [name, delivery] of cases) {
		it(`rejects ${name} without throwing`, () => {
			assertRejected(delivery, 'missing-field');
		});
	}
});

describe('task 2.3: step 2, header differs from body signature', () => {
	const other = 'A'.repeat(43) + '=';

	it('rejects a different header value', () => {
		assertRejected(goldenDelivery({ signatureHeader: other }), 'header-mismatch');
	});

	it('rejects an absent header', () => {
		assertRejected(goldenDelivery({ signatureHeader: undefined }), 'header-mismatch');
	});

	it('rejects a repeated header delivered as an array', () => {
		const { signature } = golden.envelope.sender;
		assertRejected(goldenDelivery({ signatureHeader: [signature] }), 'header-mismatch');
	});

	it('rejects a header carrying a t=/v1= style prefix', () => {
		const { signature } = golden.envelope.sender;
		assertRejected(goldenDelivery({ signatureHeader: `v1=${signature}` }), 'header-mismatch');
	});
});

describe('task 2.3: step 3, malformed or over-long base64', () => {
	const real = golden.envelope.sender.signature;
	const cases = [
		// Buffer.from(x, 'base64') would decode each of these to the real 32 bytes.
		['invalid characters a lenient decoder drops', `${real.slice(0, 20)}!!!!${real.slice(20)}`],
		['embedded whitespace', `${real.slice(0, 20)} ${real.slice(20)}`],
		['trailing newline', `${real}\n`],
		['trailing garbage after the padding', `${real}AAAA`],
		['missing padding', real.slice(0, -1)],
		['url-safe alphabet', real.replace(/\+/g, '-').replace(/\//g, '_')],
		['too short', 'QUJD'],
		['too long', `${'A'.repeat(47)}=`],
		['hex digest', 'a'.repeat(64)],
		['empty', ''],
	].filter(([, value]) => value !== real);

	for (const [name, value] of cases) {
		it(`rejects ${name}`, () => {
			const body = structuredClone(golden.envelope);
			body.sender.signature = value;
			assertRejected(goldenDelivery({ body, signatureHeader: value }), 'malformed-signature');
		});
	}
});

describe('task 2.3: step 3, non-canonical base64', () => {
	it('rejects a final character that decodes to the same bytes', () => {
		const real = golden.envelope.sender.signature;
		assert.equal(real.at(-2), 'A');
		const variant = `${real.slice(0, -2)}B=`;
		assert.deepEqual(Buffer.from(variant, 'base64'), Buffer.from(real, 'base64'));

		const body = structuredClone(golden.envelope);
		body.sender.signature = variant;
		assertRejected(goldenDelivery({ body, signatureHeader: variant }), 'malformed-signature');
	});
});

describe('task 2.3: step 4, keyId swap', () => {
	it('rejects a validly signed envelope under another keyId', () => {
		assertRejected(
			signedDelivery((body) => (body.sender.keyId = 'rule-other:1')),
			'key-id-mismatch',
		);
	});

	it('rejects when the stored keyId is absent', () => {
		assertRejected(goldenDelivery({ keyId: undefined }), 'key-id-mismatch');
	});
});

describe('task 2.3: step 5, tampered body', () => {
	const tamperings = [
		['payload field', (body) => (body.payload.details.generatedSentence = 'Forged.')],
		['recipients', (body) => (body.recipients.kind = 'incident-rule-test')],
		['messageId', (body) => (body.messageId = 'forged')],
		['added top-level key', (body) => (body.extra = true)],
		['sender.agentId, which is signed', (body) => (body.sender.agentId = 'forged')],
		['sender.signatureAlg, which is signed', (body) => (body.sender.signatureAlg = 'none')],
		['timestamp, which is signed', (body) => (body.timestamp = '2026-04-01T12:00:01.000Z')],
	];

	for (const [name, tamper] of tamperings) {
		it(`rejects a change to ${name}`, () => {
			const body = structuredClone(golden.envelope);
			tamper(body);
			assertRejected(goldenDelivery({ body }), 'bad-mac');
		});
	}

	it('reports bad-mac, not bad-timestamp, for a stale and tampered body', () => {
		const body = structuredClone(golden.envelope);
		body.payload.details.generatedSentence = 'Forged.';
		assertRejected(goldenDelivery({ body, nowMs: NOW + 60 * 60 * 1000 }), 'bad-mac');
	});

	it('rejects the right signature under the wrong secret', () => {
		assertRejected(goldenDelivery({ secret: 'another-secret' }), 'bad-mac');
	});
});

describe('task 2.3: step 6, stale, future and unparseable timestamp', () => {
	const at = (timestamp, overrides) =>
		signedDelivery((body) => (body.timestamp = timestamp), overrides);
	const iso = (offsetMs) => new Date(NOW + offsetMs).toISOString();
	const FIVE_MINUTES = 5 * 60 * 1000;

	it('accepts exactly 5 minutes old and 5 minutes ahead', () => {
		assert.equal(findRejectionReason(at(iso(-FIVE_MINUTES))), null);
		assert.equal(findRejectionReason(at(iso(FIVE_MINUTES))), null);
	});

	it('accepts a numeric UTC offset', () => {
		assert.equal(findRejectionReason(at('2026-04-01T14:00:00.000+02:00')), null);
	});

	it('rejects a stale timestamp', () => {
		assertRejected(at(iso(-FIVE_MINUTES - 1)), 'bad-timestamp');
	});

	it('rejects a future timestamp', () => {
		assertRejected(at(iso(FIVE_MINUTES + 1)), 'bad-timestamp');
	});

	for (const value of [
		'not-a-date',
		'',
		'2026-04-01',
		'2026-04-01 12:00:00Z',
		'2026-04-01T12:00:00',
		'April 1, 2026 12:00:00 UTC',
		'2026-13-01T12:00:00.000Z',
		'2026-02-31T12:00:00.000Z',
		'2026-04-01T25:00:00.000Z',
	]) {
		it(`rejects the unparseable timestamp ${JSON.stringify(value)}`, () => {
			assertRejected(at(value, { nowMs: Date.parse(value) || NOW }), 'bad-timestamp');
		});
	}
});

describe('task 2.3: never throws', () => {
	it('returns false for very deep nesting instead of a stack overflow', () => {
		let nested = 1;
		for (let i = 0; i < 200000; i++) {
			nested = [nested];
		}
		const body = structuredClone(golden.envelope);
		const delivery = goldenDelivery({ body });
		// structuredClone or the serializer overflows; the guard must absorb it.
		body.payload = nested;
		assert.equal(isAuthenticDelivery(delivery), false);
	});
});

describe('task 2.3: JCS vectors', () => {
	const vectors = [
		['number 1e21', 1e21, '1e+21'],
		['number 1e-7', 1e-7, '1e-7'],
		['number -0', -0, '0'],
		['2^53 - 1', 9007199254740991, '9007199254740991'],
		['2^53', 9007199254740992, '9007199254740992'],
		['2^53 + 2', 9007199254740994, '9007199254740994'],
		['-(2^53 - 1)', -9007199254740991, '-9007199254740991'],
		['a fractional number', 333333333.33333329, '333333333.3333333'],
		['1E30', 1e30, '1e+30'],
		['4.50', 4.5, '4.5'],
		['2e-3', 2e-3, '0.002'],
		['escaped control characters', '\u000f\n"\\', '"\\u000f\\n\\"\\\\"'],
		['non-ASCII stays literal', '€$', '"€$"'],
		['an astral character stays literal', '😀', '"😀"'],
		['forward slash is not escaped', '/', '"/"'],
		['literals', [null, true, false], '[null,true,false]'],
		['nested empties', { a: [], b: {} }, '{"a":[],"b":{}}'],
	];

	for (const [name, input, expected] of vectors) {
		it(`serializes ${name}`, () => {
			assert.equal(canonicalizeJcs(input), expected);
		});
	}

	it('sorts keys by UTF-16 code unit (RFC 8785 section 3.2.3 example)', () => {
		const input = JSON.parse(
			'{"\\u20ac":"Euro Sign","\\r":"Carriage Return","\\ufb33":"Hebrew Letter Dalet With Dagesh",' +
				'"1":"One","\\ud83d\\ude00":"Emoji: Grinning Face","\\u0080":"Control",' +
				'"\\u00f6":"Latin Small Letter O With Diaeresis"}',
		);
		const keys = Object.keys(JSON.parse(canonicalizeJcs(input)));
		assert.deepEqual(
			[...canonicalizeJcs(input).matchAll(/"([^"]+)":"/g)].map((match) => match[1]),
			['\\r', '1', '\u0080', 'ö', '€', '😀', 'דּ'],
		);
		assert.equal(keys.length, 7);
	});

	it('orders keys by code unit, not code point, around surrogates', () => {
		// U+1F600 sorts before U+FB33 only when compared as UTF-16 code units.
		assert.equal(canonicalizeJcs({ דּ: 1, '😀': 2 }), '{"😀":2,"דּ":1}');
	});

	it('sorts nested objects and keeps array order', () => {
		assert.equal(
			canonicalizeJcs({ b: [{ d: 1, c: 2 }, 3], a: 0 }),
			'{"a":0,"b":[{"c":2,"d":1},3]}',
		);
	});

	it('keeps an own __proto__ key from JSON.parse', () => {
		const input = JSON.parse('{"z":1,"__proto__":{"polluted":true},"a":2}');
		assert.equal(canonicalizeJcs(input), '{"__proto__":{"polluted":true},"a":2,"z":1}');
		assert.equal({}.polluted, undefined);
	});

	it('covers an own __proto__ key in the signature, surviving the deep copy', () => {
		const withProto = () =>
			Object.assign(structuredClone(golden.envelope), {
				payload: JSON.parse('{"__proto__":{"a":1},"b":2}'),
			});
		const body = withProto();
		const signature = createHmac('sha256', golden.secret)
			.update(signedBytes(body))
			.digest('base64');
		body.sender.signature = signature;
		const delivery = goldenDelivery({ body, signatureHeader: signature });
		assert.equal(findRejectionReason(delivery), null);

		const tampered = structuredClone(body);
		tampered.payload = JSON.parse('{"__proto__":{"a":2},"b":2}');
		assertRejected(goldenDelivery({ body: tampered, signatureHeader: signature }), 'bad-mac');
	});

	it('signs the envelope minus sender.signature only', () => {
		const bytes = signedBytes(golden.envelope).toString('utf8');
		assert.ok(bytes.includes('"signatureAlg":"hmac-sha256"'));
		assert.ok(bytes.includes(`"keyId":"${golden.keyId}"`));
		assert.ok(!bytes.includes('"signature":'));
	});

	it('refuses non-finite numbers and non-JSON values', () => {
		assert.throws(() => canonicalizeJcs(Number.NaN), TypeError);
		assert.throws(() => canonicalizeJcs(Number.POSITIVE_INFINITY), TypeError);
		assert.throws(() => canonicalizeJcs(undefined), TypeError);
	});
});
