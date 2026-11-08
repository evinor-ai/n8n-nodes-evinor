// Task 2.4: output mapping (full and Simplify), including isTest.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import output from '../dist/nodes/EvinorTrigger/output.js';

const { mapEnvelopeToOutput } = output;

const load = (name) =>
	JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')).envelope;

const envelope = load('golden-envelope.json');
const testEnvelope = load('golden-test-envelope.json');

describe('task 2.4: full output', () => {
	it('returns the whole payload plus messageId, idempotencyKey and isTest', () => {
		assert.deepEqual(mapEnvelopeToOutput(envelope, false), {
			...envelope.payload,
			messageId: envelope.messageId,
			idempotencyKey: envelope.idempotencyKey,
			isTest: false,
		});
	});

	it('never carries the sender block or the signature', () => {
		const item = JSON.stringify(mapEnvelopeToOutput(envelope, false));
		assert.ok(!item.includes(envelope.sender.signature));
		assert.ok(!item.includes('"sender"'));
	});

	it('does not let a payload key shadow the dedup fields', () => {
		const shadowing = {
			...envelope,
			payload: { messageId: 'shadow', idempotencyKey: 'shadow', isTest: true },
		};
		const item = mapEnvelopeToOutput(shadowing, false);
		assert.equal(item.messageId, envelope.messageId);
		assert.equal(item.idempotencyKey, envelope.idempotencyKey);
		assert.equal(item.isTest, false);
	});
});

describe('task 2.4: isTest', () => {
	it('is true for incident-rule-test recipients, in both modes', () => {
		assert.equal(mapEnvelopeToOutput(testEnvelope, false).isTest, true);
		assert.equal(mapEnvelopeToOutput(testEnvelope, true).isTest, true);
	});

	it('is false for incident-rule-action recipients, in both modes', () => {
		assert.equal(mapEnvelopeToOutput(envelope, false).isTest, false);
		assert.equal(mapEnvelopeToOutput(envelope, true).isTest, false);
	});

	it('is false when recipients is absent', () => {
		const { recipients: _recipients, ...withoutRecipients } = envelope;
		assert.equal(mapEnvelopeToOutput(withoutRecipients, false).isTest, false);
	});
});

describe('task 2.4: Simplify', () => {
	const simplified = mapEnvelopeToOutput(envelope, true);

	it('flattens roles to { CODE: textValue }', () => {
		assert.deepEqual(simplified.roles, {
			COMPANY_NAME: 'TechCorp',
			AFFECTED_EMPLOYEES_COUNT: '200 people',
		});
	});

	it('adds parsed values, only for roles that have them', () => {
		assert.deepEqual(simplified.parsedValues, {
			AFFECTED_EMPLOYEES_COUNT: { parsedAmount: 200 },
		});
	});

	it('includes parsedDate and parsedAmountUnit for a role', () => {
		const item = mapEnvelopeToOutput(
			{
				...envelope,
				payload: {
					details: {
						roles: [
							{
								code: 'DEAL_VALUE',
								textValue: '$5M on May 1',
								parsedAmount: 5000000,
								parsedAmountUnit: 'USD',
								parsedDate: '2026-05-01',
							},
						],
					},
				},
			},
			true,
		);
		assert.deepEqual(item.parsedValues, {
			DEAL_VALUE: { parsedAmount: 5000000, parsedAmountUnit: 'USD', parsedDate: '2026-05-01' },
		});
	});

	it('returns payload.details at the top level, keeping the dedup fields', () => {
		assert.equal(simplified.generatedSentence, envelope.payload.details.generatedSentence);
		assert.equal(simplified.incidentId, envelope.payload.details.incidentId);
		assert.equal(simplified.eventCodeName, undefined);
		assert.equal(simplified.messageId, envelope.messageId);
		assert.equal(simplified.idempotencyKey, envelope.idempotencyKey);
	});

	it('keeps every value of a role code that repeats', () => {
		const multi = {
			...envelope,
			payload: {
				details: {
					roles: [
						{ code: 'COMPANY_NAME', textValue: 'A', parsedAmount: 1 },
						{ code: 'COMPANY_NAME', textValue: 'B', parsedAmount: 2 },
					],
				},
			},
		};
		const item = mapEnvelopeToOutput(multi, true);
		assert.deepEqual(item.roles, { COMPANY_NAME: ['A', 'B'] });
		assert.deepEqual(item.parsedValues, {
			COMPANY_NAME: [{ parsedAmount: 1 }, { parsedAmount: 2 }],
		});
	});

	it('treats a __proto__ role code as data, without touching any prototype', () => {
		const hostile = {
			...envelope,
			payload: { details: { roles: [{ code: '__proto__', textValue: 'value' }] } },
		};
		const { roles } = mapEnvelopeToOutput(hostile, true);
		assert.equal(Object.getPrototypeOf(roles), Object.prototype);
		assert.ok(Object.prototype.hasOwnProperty.call(roles, '__proto__'));
		assert.equal({}.value, undefined);
	});

	it('does not throw when details or roles are missing', () => {
		const noDetails = mapEnvelopeToOutput({ ...envelope, payload: {} }, true);
		assert.deepEqual(noDetails.roles, {});
		assert.deepEqual(noDetails.parsedValues, {});
	});

	it('leaves the input envelope unchanged', () => {
		const before = structuredClone(envelope);
		mapEnvelopeToOutput(envelope, true);
		assert.deepEqual(envelope, before);
	});
});
