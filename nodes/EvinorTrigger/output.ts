import type { IDataObject } from 'n8n-workflow';

function asObject(value: unknown): IDataObject {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
		? (value as IDataObject)
		: {};
}

/**
 * Groups values by role code. A code that occurs once maps to its value; a code
 * that occurs several times (a multi-value role) maps to an array, so nothing
 * is lost. `Object.fromEntries` defines own properties, so a code such as
 * `__proto__` cannot alter the result's prototype.
 */
function collapseByCode(entries: Array<[string, unknown]>): IDataObject {
	const grouped = new Map<string, unknown[]>();
	for (const [code, value] of entries) {
		grouped.set(code, [...(grouped.get(code) ?? []), value]);
	}
	return Object.fromEntries(
		[...grouped].map(([code, values]) => [code, values.length === 1 ? values[0] : values]),
	) as IDataObject;
}

function pickParsedValues(role: IDataObject): IDataObject | undefined {
	const parsed = Object.fromEntries(
		(['parsedAmount', 'parsedAmountUnit', 'parsedDate'] as const)
			.filter((key) => role[key] !== undefined)
			.map((key) => [key, role[key]]),
	);
	return Object.keys(parsed).length > 0 ? (parsed as IDataObject) : undefined;
}

function simplifyDetails(details: IDataObject): IDataObject {
	const rawRoles: unknown[] = Array.isArray(details.roles) ? details.roles : [];
	const roles = rawRoles
		.map(asObject)
		.filter((role): role is IDataObject & { code: string } => typeof role.code === 'string');

	return {
		...details,
		roles: collapseByCode(roles.map((role) => [role.code, role.textValue])),
		parsedValues: collapseByCode(
			roles.flatMap((role): Array<[string, unknown]> => {
				const parsed = pickParsedValues(role);
				return parsed === undefined ? [] : [[role.code, parsed]];
			}),
		),
	};
}

/**
 * Maps a verified envelope to the node's output item. The `sender` block, and
 * with it the signature, is never part of the output.
 */
export function mapEnvelopeToOutput(envelope: IDataObject, simplify: boolean): IDataObject {
	const payload = asObject(envelope.payload);
	const content = simplify ? simplifyDetails(asObject(payload.details)) : payload;

	return {
		...content,
		messageId: envelope.messageId,
		idempotencyKey: envelope.idempotencyKey,
		isTest: asObject(envelope.recipients).kind === 'incident-rule-test',
	};
}
