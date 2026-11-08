// Task 2.2 and the webhook() clause of task 2.3 (design Decisions 3 and 4).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import nodeModule from '../dist/nodes/EvinorTrigger/EvinorTrigger.node.js';
import credentialModule from '../dist/credentials/EvinorApi.credentials.js';

const { EvinorTrigger } = nodeModule;
const { EvinorApi } = credentialModule;

const node = new EvinorTrigger();
const hooks = node.webhookMethods.default;
const searchSensors = node.methods.listSearch.searchSensors;

const BASE = 'https://api.evinor.test';
const WEBHOOK_URL = 'https://n8n.example.com/webhook/abc/webhook';
const SENSOR = 'sensor 1/x';
const SENSOR_PATH = `${BASE}/v1/sensors/sensor%201%2Fx`;

function hookContext({ activationMode = 'activate', staticData = {}, responses = [] } = {}) {
	const queue = [...responses];
	const httpRequestWithAuthentication = mock.fn(async () => {
		const next = queue.shift();
		if (next instanceof Error) {
			throw next;
		}
		return next;
	});
	const warnings = [];
	const context = {
		getActivationMode: () => activationMode,
		getNodeParameter: (name, _fallback, options) => {
			assert.equal(name, 'sensor');
			assert.deepEqual(options, { extractValue: true });
			return SENSOR;
		},
		getWorkflowStaticData: (type) => {
			assert.equal(type, 'node');
			return staticData;
		},
		getNodeWebhookUrl: (name) => {
			assert.equal(name, 'default');
			return WEBHOOK_URL;
		},
		getCredentials: async () => ({ apiKey: 'key', baseUrl: `${BASE}/` }),
		getNode: () => ({ name: 'Evinor Trigger', type: 'evinorTrigger', typeVersion: 1 }),
		logger: { warn: (message) => warnings.push(message) },
		helpers: { httpRequestWithAuthentication },
	};
	const calls = () => httpRequestWithAuthentication.mock.calls.map((call) => call.arguments[1]);
	return { context, staticData, calls, warnings, httpRequestWithAuthentication };
}

const response = (statusCode, body = {}) => ({ statusCode, body });

const SIGNING = { signing_secret: 'whsec_new', key_id: 'rule:9' };

describe('task 2.2: checkExists (manual)', () => {
	it('returns false without any HTTP call', async () => {
		const { context, calls } = hookContext({
			activationMode: 'manual',
			staticData: { kind: 'production', destinationId: 'dest-1' },
		});
		assert.equal(await hooks.checkExists.call(context), false);
		assert.equal(calls().length, 0);
	});
});

describe('task 2.2: checkExists (production)', () => {
	const stored = () => ({ kind: 'production', destinationId: 'dest 1', secret: 's', keyId: 'k' });

	it('GETs the stored destination and is true when the URL matches', async () => {
		const { context, calls } = hookContext({
			staticData: stored(),
			responses: [response(200, { url: WEBHOOK_URL, status: 'connected' })],
		});
		assert.equal(await hooks.checkExists.call(context), true);
		assert.equal(calls()[0].method, 'GET');
		assert.equal(calls()[0].url, `${SENSOR_PATH}/destinations/dest%201`);
	});

	it('is false when the URL differs', async () => {
		const { context } = hookContext({
			staticData: stored(),
			responses: [response(200, { url: 'https://other.example.com/hook' })],
		});
		assert.equal(await hooks.checkExists.call(context), false);
	});

	it('is false while the row is waiting (url is null)', async () => {
		const { context } = hookContext({
			staticData: stored(),
			responses: [response(200, { url: null, status: 'waiting' })],
		});
		assert.equal(await hooks.checkExists.call(context), false);
	});

	it('is false on 404', async () => {
		const { context } = hookContext({
			staticData: stored(),
			responses: [response(404, { detail: 'gone' })],
		});
		assert.equal(await hooks.checkExists.call(context), false);
	});

	it('is false with no HTTP call when no destinationId is stored', async () => {
		const { context, calls } = hookContext();
		assert.equal(await hooks.checkExists.call(context), false);
		assert.equal(calls().length, 0);
	});

	for (const statusCode of [401, 403]) {
		it(`throws the API detail on ${statusCode}`, async () => {
			const { context } = hookContext({
				staticData: stored(),
				responses: [response(statusCode, { detail: 'denied by Evinor' })],
			});
			await assert.rejects(hooks.checkExists.call(context), /denied by Evinor/);
		});
	}

	for (const statusCode of [429, 500, 503]) {
		it(`keeps the destination and secret on ${statusCode}, logging only the status`, async () => {
			const { context, staticData, warnings } = hookContext({
				staticData: stored(),
				responses: [response(statusCode, { detail: 'private detail' })],
			});
			assert.equal(await hooks.checkExists.call(context), true);
			assert.deepEqual(staticData, stored());
			assert.equal(warnings.length, 1);
			assert.ok(warnings[0].includes(String(statusCode)));
			assert.ok(!warnings[0].includes('private detail'));
		});
	}

	it('keeps the destination and secret when the request throws', async () => {
		const { context, staticData, warnings } = hookContext({
			staticData: stored(),
			responses: [new Error('socket hang up, private detail')],
		});
		assert.equal(await hooks.checkExists.call(context), true);
		assert.deepEqual(staticData, stored());
		assert.equal(warnings.length, 1);
		assert.ok(!warnings[0].includes('private detail'));
	});
});

describe('task 2.2: create (manual)', () => {
	it('POSTs test-deliveries and stores kind, secret and keyId, never destinationId', async () => {
		const { context, calls, staticData } = hookContext({
			activationMode: 'manual',
			staticData: { stale: true },
			responses: [response(202, { id: 'test-1', ...SIGNING })],
		});
		assert.equal(await hooks.create.call(context), true);
		assert.equal(calls()[0].method, 'POST');
		assert.equal(calls()[0].url, `${SENSOR_PATH}/test-deliveries`);
		assert.deepEqual(calls()[0].body, { url: WEBHOOK_URL });
		assert.deepEqual(staticData, { kind: 'test', secret: 'whsec_new', keyId: 'rule:9' });
	});

	it('surfaces the API detail on 429, without retrying', async () => {
		const { context, calls, staticData } = hookContext({
			activationMode: 'manual',
			responses: [response(429, { detail: 'Too many test deliveries.' })],
		});
		await assert.rejects(hooks.create.call(context), /Too many test deliveries\./);
		assert.equal(calls().length, 1);
		assert.deepEqual(staticData, {});
	});
});

describe('task 2.2: create (other activation modes)', () => {
	for (const activationMode of ['activate', 'init', 'update', 'leadershipChange']) {
		it(`POSTs destinations and stores snake_case fields mapped to node keys (${activationMode})`, async () => {
			const { context, calls, staticData } = hookContext({
				activationMode,
				staticData: { kind: 'test', leftover: 'x' },
				responses: [response(201, { id: 'dest-9', url: WEBHOOK_URL, ...SIGNING })],
			});
			assert.equal(await hooks.create.call(context), true);
			assert.equal(calls()[0].method, 'POST');
			assert.equal(calls()[0].url, `${SENSOR_PATH}/destinations`);
			assert.deepEqual(calls()[0].body, { type: 'connected_app', app: 'n8n', url: WEBHOOK_URL });
			assert.deepEqual(staticData, {
				kind: 'production',
				destinationId: 'dest-9',
				secret: 'whsec_new',
				keyId: 'rule:9',
			});
		});
	}

	it('sends through the evinorApi credential with status errors disabled', async () => {
		const { context, httpRequestWithAuthentication } = hookContext({
			responses: [response(201, { id: 'dest-9', ...SIGNING })],
		});
		await hooks.create.call(context);
		const [credential, options] = httpRequestWithAuthentication.mock.calls[0].arguments;
		assert.equal(credential, 'evinorApi');
		assert.equal(options.ignoreHttpStatusErrors, true);
		assert.equal(options.returnFullResponse, true);
	});
});

describe('task 2.2: failed create clears static data', () => {
	const previous = () => ({
		kind: 'production',
		destinationId: 'old',
		secret: 'old',
		keyId: 'old',
	});

	it('clears on a 404 and shows the API detail', async () => {
		const { context, staticData } = hookContext({
			staticData: previous(),
			responses: [response(404, { detail: 'No sensor or destination matches the requested id.' })],
		});
		await assert.rejects(hooks.create.call(context), /No sensor or destination matches/);
		assert.deepEqual(staticData, {});
	});

	it('clears on a 400 unreachable-URL answer and shows the API detail', async () => {
		const { context, staticData } = hookContext({
			staticData: previous(),
			responses: [response(400, { detail: 'The URL must be reachable over public HTTPS.' })],
		});
		await assert.rejects(hooks.create.call(context), /public HTTPS/);
		assert.deepEqual(staticData, {});
	});

	it('clears on a transport error', async () => {
		const { context, staticData } = hookContext({
			staticData: previous(),
			responses: [new Error('socket hang up')],
		});
		await assert.rejects(hooks.create.call(context), /socket hang up/);
		assert.deepEqual(staticData, {});
	});

	it('clears when a 2xx omits the signing details, without echoing the body', async () => {
		const { context, staticData } = hookContext({
			staticData: previous(),
			responses: [response(201, { id: 'dest-1', signing_secret: 'do-not-echo' })],
		});
		await assert.rejects(hooks.create.call(context), (error) => {
			assert.ok(!error.message.includes('do-not-echo'));
			return true;
		});
		assert.deepEqual(staticData, {});
	});

	it('uses a generic message when the API sends no detail', async () => {
		const { context } = hookContext({ responses: [response(502, '<html>')] });
		await assert.rejects(hooks.create.call(context), /status 502/);
	});
});

describe('task 2.2: delete', () => {
	it("with kind: 'test' makes no HTTP call, clears keys and returns true", async () => {
		const { context, calls, staticData } = hookContext({
			staticData: { kind: 'test', secret: 's', keyId: 'k' },
		});
		assert.equal(await hooks.delete.call(context), true);
		assert.equal(calls().length, 0);
		assert.deepEqual(staticData, {});
	});

	it("with kind: 'test' and a stray destinationId still makes no HTTP call", async () => {
		const { context, calls, staticData } = hookContext({
			staticData: { kind: 'test', destinationId: 'live-destination', secret: 's' },
		});
		assert.equal(await hooks.delete.call(context), true);
		assert.equal(calls().length, 0);
		assert.deepEqual(staticData, {});
	});

	it('with a destinationId but no kind makes no HTTP call', async () => {
		const { context, calls } = hookContext({ staticData: { destinationId: 'live-destination' } });
		assert.equal(await hooks.delete.call(context), true);
		assert.equal(calls().length, 0);
	});

	it("with kind: 'production' and no destinationId makes no HTTP call", async () => {
		const { context, calls, staticData } = hookContext({ staticData: { kind: 'production' } });
		assert.equal(await hooks.delete.call(context), true);
		assert.equal(calls().length, 0);
		assert.deepEqual(staticData, {});
	});

	const production = () => ({
		kind: 'production',
		destinationId: 'dest-1',
		secret: 's',
		keyId: 'k',
	});

	it('production: DELETEs the destination, clears keys and returns true', async () => {
		const { context, calls, staticData } = hookContext({
			staticData: production(),
			responses: [response(204)],
		});
		assert.equal(await hooks.delete.call(context), true);
		assert.equal(calls()[0].method, 'DELETE');
		assert.equal(calls()[0].url, `${SENSOR_PATH}/destinations/dest-1`);
		assert.deepEqual(staticData, {});
	});

	it('production: percent-encodes a destination id containing a space', async () => {
		const { context, calls } = hookContext({
			staticData: { ...production(), destinationId: 'dest 1' },
			responses: [response(204)],
		});
		assert.equal(await hooks.delete.call(context), true);
		assert.equal(calls()[0].url, `${SENSOR_PATH}/destinations/dest%201`);
	});

	it('production: 404 counts as success', async () => {
		const { context, staticData } = hookContext({
			staticData: production(),
			responses: [response(404, { detail: 'gone' })],
		});
		assert.equal(await hooks.delete.call(context), true);
		assert.deepEqual(staticData, {});
	});

	it('production: another failure returns false and keeps the keys', async () => {
		const { context, staticData, warnings } = hookContext({
			staticData: production(),
			responses: [response(500, { detail: 'boom' })],
		});
		assert.equal(await hooks.delete.call(context), false);
		assert.deepEqual(staticData, production());
		assert.equal(warnings.length, 1);
		assert.ok(!warnings[0].includes('s,'));
	});

	it('production: a transport error returns false and keeps the keys', async () => {
		const { context, staticData } = hookContext({
			staticData: production(),
			responses: [new Error('socket hang up')],
		});
		assert.equal(await hooks.delete.call(context), false);
		assert.deepEqual(staticData, production());
	});
});

describe('task 2.2: dot-segment destination ids', () => {
	for (const destinationId of ['.', '..']) {
		const stored = () => ({ kind: 'production', destinationId, secret: 's', keyId: 'k' });

		it(`checkExists treats ${JSON.stringify(destinationId)} as absent, with no HTTP call`, async () => {
			const { context, calls } = hookContext({ staticData: stored() });
			assert.equal(await hooks.checkExists.call(context), false);
			assert.equal(calls().length, 0);
		});

		it(`delete treats ${JSON.stringify(destinationId)} as absent, with no HTTP call`, async () => {
			const { context, calls, staticData } = hookContext({
				staticData: stored(),
				responses: [response(204)],
			});
			assert.equal(await hooks.delete.call(context), true);
			assert.equal(calls().length, 0);
			assert.deepEqual(staticData, {});
		});
	}
});

describe('task 2.2: dot-segment sensor ids', () => {
	const production = () => ({ kind: 'production', destinationId: 'dest-1', secret: 's', keyId: 'k' });

	for (const sensorId of ['.', '..']) {
		for (const [hook, activationMode] of [
			['checkExists', 'activate'],
			['create', 'activate'],
			['create', 'manual'],
			['delete', 'activate'],
		]) {
			it(`${hook} (${activationMode}) rejects ${JSON.stringify(sensorId)} before any request`, async () => {
				const { context, calls } = hookContext({ activationMode, staticData: production() });
				context.getNodeParameter = () => sensorId;
				await assert.rejects(hooks[hook].call(context), /The sensor ID is not valid/);
				assert.equal(calls().length, 0);
			});
		}
	}
});

describe('task 2.2: sensor selection', () => {
	function loadContext(responses) {
		const { context, calls } = hookContext({ responses });
		return { context, calls };
	}

	it('lists sensors with the enabled state and passes pagination through', async () => {
		const { context, calls } = loadContext([
			response(200, {
				data: [
					{ id: 'a', name: 'Layoffs', enabled: true },
					{ id: 'b', name: 'Funding', enabled: false },
				],
				has_more: true,
				next_cursor: 'cursor-2',
			}),
		]);
		const result = await searchSensors.call(context, undefined, 'cursor-1');
		assert.deepEqual(result, {
			results: [
				{ name: 'Layoffs', value: 'a' },
				{ name: 'Funding (disabled)', value: 'b' },
			],
			paginationToken: 'cursor-2',
		});
		assert.equal(calls()[0].url, `${BASE}/v1/sensors`);
		assert.deepEqual(calls()[0].qs, { limit: 100, starting_after: 'cursor-1' });
	});

	it('filters by name, case-insensitively, and ends pagination', async () => {
		const { context } = loadContext([
			response(200, {
				data: [
					{ id: 'a', name: 'Layoffs', enabled: true },
					{ id: 'b', name: 'Funding', enabled: true },
				],
				has_more: false,
				next_cursor: null,
			}),
		]);
		assert.deepEqual(await searchSensors.call(context, 'LAY'), {
			results: [{ name: 'Layoffs', value: 'a' }],
		});
	});

	it('offers list and ID modes on the resource locator', () => {
		const sensor = node.description.properties.find((property) => property.name === 'sensor');
		assert.equal(sensor.type, 'resourceLocator');
		assert.deepEqual(
			sensor.modes.map((mode) => mode.name),
			['list', 'id'],
		);
	});

	it('declares the POST webhook and a Simplify toggle', () => {
		assert.deepEqual(node.description.webhooks, [
			{ name: 'default', httpMethod: 'POST', responseMode: 'onReceived', path: 'webhook' },
		]);
		const simplify = node.description.properties.find((property) => property.name === 'simplify');
		assert.equal(simplify.type, 'boolean');
		assert.equal(simplify.default, false);
	});
});

describe('task 2.1: credential', () => {
	const credential = new EvinorApi();

	it('authenticates with a bearer header', () => {
		assert.equal(
			credential.authenticate.properties.headers.Authorization,
			'=Bearer {{$credentials.apiKey}}',
		);
	});

	it('tests with GET /v1/sensors against the configured base URL', () => {
		assert.deepEqual(credential.test.request, {
			baseURL: '={{$credentials.baseUrl}}',
			url: '/v1/sensors',
			method: 'GET',
		});
	});

	it('defaults to production and has no https-only validation on the base URL', () => {
		const baseUrl = credential.properties.find((property) => property.name === 'baseUrl');
		assert.equal(baseUrl.default, 'https://api.evinor.ai');
		assert.equal(baseUrl.typeOptions, undefined);
	});

	it('masks the API key', () => {
		const apiKey = credential.properties.find((property) => property.name === 'apiKey');
		assert.equal(apiKey.typeOptions.password, true);
	});
});

describe('task 2.3: webhook()', () => {
	const fixture = JSON.parse(
		readFileSync(new URL('./fixtures/golden-envelope.json', import.meta.url), 'utf8'),
	);
	const testFixture = JSON.parse(
		readFileSync(new URL('./fixtures/golden-test-envelope.json', import.meta.url), 'utf8'),
	);

	beforeEach(() => {
		mock.timers.enable({ apis: ['Date'], now: Date.parse(fixture.clock) });
	});
	afterEach(() => {
		mock.timers.reset();
	});

	function webhookContext({
		body = structuredClone(fixture.envelope),
		header = fixture.envelope.sender.signature,
		staticData = { kind: 'production', secret: fixture.secret, keyId: fixture.keyId },
		simplify = false,
		overrides = {},
	} = {}) {
		const sent = [];
		const res = {
			status(code) {
				sent.push({ code });
				return this;
			},
			json(payload) {
				sent[sent.length - 1].payload = payload;
				return this;
			},
		};
		const context = {
			getWorkflowStaticData: () => staticData,
			getBodyData: () => body,
			getHeaderData: () => ({ 'x-evinor-signature': header }),
			getNodeParameter: () => simplify,
			getResponseObject: () => res,
			helpers: { returnJsonArray: (item) => [{ json: item }] },
			...overrides,
		};
		return { context, sent };
	}

	const UNAUTHORIZED = [{ code: 401, payload: { message: 'Unauthorized' } }];

	async function assertUniform401(args) {
		const { context, sent } = webhookContext(args);
		const result = await node.webhook.call(context);
		assert.deepEqual(result, { noWebhookResponse: true });
		assert.equal(result.workflowData, undefined);
		assert.deepEqual(sent, UNAUTHORIZED);
	}

	it('runs the workflow with the mapped envelope for a valid delivery', async () => {
		const { context, sent } = webhookContext();
		const result = await node.webhook.call(context);
		assert.equal(sent.length, 0);
		const [[item]] = result.workflowData;
		assert.equal(item.json.messageId, fixture.envelope.messageId);
		assert.equal(item.json.isTest, false);
		assert.equal(item.json.details.incidentId, 'incident-golden-1');
	});

	it('marks a verified test delivery with isTest', async () => {
		const { context } = webhookContext({
			body: structuredClone(testFixture.envelope),
			header: testFixture.envelope.sender.signature,
			staticData: { kind: 'test', secret: testFixture.secret, keyId: testFixture.keyId },
		});
		const result = await node.webhook.call(context);
		assert.equal(result.workflowData[0][0].json.isTest, true);
	});

	it('applies Simplify when it is on', async () => {
		const { context } = webhookContext({ simplify: true });
		const result = await node.webhook.call(context);
		assert.equal(result.workflowData[0][0].json.roles.COMPANY_NAME, 'TechCorp');
	});

	it('never puts the signing secret in the output', async () => {
		const { context } = webhookContext();
		const result = await node.webhook.call(context);
		assert.ok(!JSON.stringify(result).includes(fixture.secret));
	});

	it('401s without a run when the secret is absent', async () => {
		await assertUniform401({ staticData: {} });
	});

	it('401s without a run on a mismatched header', async () => {
		await assertUniform401({ header: `${'A'.repeat(43)}=` });
	});

	it('401s without a run on a tampered body', async () => {
		const body = structuredClone(fixture.envelope);
		body.payload.details.generatedSentence = 'Forged.';
		await assertUniform401({ body });
	});

	it('401s without a run on a keyId swap', async () => {
		await assertUniform401({
			staticData: { kind: 'production', secret: fixture.secret, keyId: 'rule-other:1' },
		});
	});

	it('401s without a run on a stale delivery', async () => {
		mock.timers.setTime(Date.parse(fixture.clock) + 5 * 60 * 1000 + 1);
		await assertUniform401({});
	});

	for (const body of [null, [], 'text', 7]) {
		it(`401s without a run on the non-object body ${JSON.stringify(body)}`, async () => {
			await assertUniform401({ body });
		});
	}

	it('turns an unexpected error into the same 401', async () => {
		await assertUniform401({
			overrides: {
				getBodyData: () => {
					throw new Error('unexpected');
				},
			},
		});
	});

	it('does not answer 401 when mapping fails on an authentic delivery', async () => {
		const { context, sent } = webhookContext({
			overrides: {
				helpers: {
					returnJsonArray: () => {
						throw new Error('mapping failed');
					},
				},
			},
		});
		await assert.rejects(node.webhook.call(context), /mapping failed/);
		assert.deepEqual(sent, []);
	});
});
