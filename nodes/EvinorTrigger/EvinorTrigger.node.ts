import type {
	IDataObject,
	IHookFunctions,
	IHttpRequestMethods,
	ILoadOptionsFunctions,
	INodeListSearchItems,
	INodeListSearchResult,
	INodeType,
	INodeTypeDescription,
	IWebhookFunctions,
	IWebhookResponseData,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError, NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

import { mapEnvelopeToOutput } from './output';
import { isAuthenticDelivery } from './verifier';

interface EvinorResponse {
	statusCode: number;
	body: IDataObject;
}

/**
 * Calls the Evinor API and returns the status instead of throwing on non-2xx,
 * so each hook can branch on it (404 is a normal answer for several of them).
 */
async function evinorRequest(
	this: IHookFunctions | ILoadOptionsFunctions,
	method: IHttpRequestMethods,
	path: string,
	options: { body?: IDataObject; qs?: IDataObject } = {},
): Promise<EvinorResponse> {
	const credentials = await this.getCredentials('evinorApi');
	const baseUrl = String(credentials.baseUrl).replace(/\/+$/, '');
	const response = (await this.helpers.httpRequestWithAuthentication.call(this, 'evinorApi', {
		method,
		url: `${baseUrl}${path}`,
		json: true,
		ignoreHttpStatusErrors: true,
		returnFullResponse: true,
		...options,
	})) as { statusCode: number; body: unknown };
	const body =
		typeof response.body === 'object' && response.body !== null
			? (response.body as IDataObject)
			: {};
	return { statusCode: response.statusCode, body };
}

function isSuccess(statusCode: number): boolean {
	return statusCode >= 200 && statusCode < 300;
}

function apiError(this: IHookFunctions | ILoadOptionsFunctions, response: EvinorResponse) {
	const detail =
		typeof response.body.detail === 'string'
			? response.body.detail
			: `The Evinor API answered with status ${response.statusCode}`;
	return new NodeApiError(this.getNode(), { detail } as JsonObject, {
		message: detail,
		httpCode: String(response.statusCode),
	});
}

// encodeURIComponent leaves dots alone, and a URL parser collapses these segments.
function isDotSegment(id: string): boolean {
	return id === '.' || id === '..';
}

function sensorPath(this: IHookFunctions): string {
	const sensorId = this.getNodeParameter('sensor', undefined, { extractValue: true }) as string;
	if (isDotSegment(sensorId)) {
		throw new NodeOperationError(this.getNode(), 'The sensor ID is not valid');
	}
	return `/v1/sensors/${encodeURIComponent(sensorId)}`;
}

function replaceStaticData(data: IDataObject, next: IDataObject): void {
	for (const key of Object.keys(data)) {
		delete data[key];
	}
	Object.assign(data, next);
}

function readSigningMaterial(
	this: IHookFunctions,
	body: IDataObject,
): { secret: string; keyId: string } {
	const { signing_secret: secret, key_id: keyId } = body;
	if (typeof secret !== 'string' || secret === '' || typeof keyId !== 'string' || keyId === '') {
		throw new NodeOperationError(
			this.getNode(),
			'The Evinor API response did not include signing details',
		);
	}
	return { secret, keyId };
}

function rejectDelivery(context: IWebhookFunctions): IWebhookResponseData {
	context.getResponseObject().status(401).json({ message: 'Unauthorized' });
	return { noWebhookResponse: true };
}

export class EvinorTrigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Evinor Trigger',
		name: 'evinorTrigger',
		icon: { light: 'file:evinor.svg', dark: 'file:evinor.dark.svg' },
		group: ['trigger'],
		version: 1,
		subtitle: 'On sensor match',
		description: 'Starts the workflow when an Evinor sensor matches an event',
		defaults: { name: 'Evinor Trigger' },
		inputs: [],
		outputs: [NodeConnectionTypes.Main],
		credentials: [{ name: 'evinorApi', required: true }],
		webhooks: [
			{
				name: 'default',
				httpMethod: 'POST',
				responseMode: 'onReceived',
				path: 'webhook',
			},
		],
		properties: [
			{
				displayName: 'Sensor',
				name: 'sensor',
				type: 'resourceLocator',
				default: { mode: 'list', value: '' },
				required: true,
				description: 'The Evinor sensor that starts this workflow',
				modes: [
					{
						displayName: 'From List',
						name: 'list',
						type: 'list',
						typeOptions: {
							searchListMethod: 'searchSensors',
							searchable: true,
						},
					},
					{
						displayName: 'By ID',
						name: 'id',
						type: 'string',
						placeholder: 'e.g. 3f1c2b9a-52de-4a53-9c1e-7a1f0e6b8d21',
					},
				],
			},
			{
				displayName: 'Simplify',
				name: 'simplify',
				type: 'boolean',
				default: false,
				description:
					'Whether to return only the event details, with roles flattened to code and value pairs',
			},
		],
	};

	methods = {
		listSearch: {
			async searchSensors(
				this: ILoadOptionsFunctions,
				filter?: string,
				paginationToken?: string,
			): Promise<INodeListSearchResult> {
				const qs: IDataObject = { limit: 100 };
				if (paginationToken) {
					qs.starting_after = paginationToken;
				}
				const response = await evinorRequest.call(this, 'GET', '/v1/sensors', { qs });
				if (!isSuccess(response.statusCode)) {
					throw apiError.call(this, response);
				}

				const needle = (filter ?? '').toLowerCase();
				const sensors = (response.body.data ?? []) as IDataObject[];
				const results: INodeListSearchItems[] = sensors
					.filter((sensor) => String(sensor.name).toLowerCase().includes(needle))
					.map((sensor) => ({
						name: sensor.enabled ? String(sensor.name) : `${String(sensor.name)} (disabled)`,
						value: String(sensor.id),
					}));

				return response.body.has_more === true && typeof response.body.next_cursor === 'string'
					? { results, paginationToken: response.body.next_cursor }
					: { results };
			},
		},
	};

	webhookMethods = {
		default: {
			async checkExists(this: IHookFunctions): Promise<boolean> {
				// A manual test always requests a fresh delivery from `create`.
				if (this.getActivationMode() === 'manual') {
					return false;
				}
				const { destinationId } = this.getWorkflowStaticData('node');
				if (
					typeof destinationId !== 'string' ||
					destinationId === '' ||
					isDotSegment(destinationId)
				) {
					return false;
				}

				const path = `${sensorPath.call(this)}/destinations/${encodeURIComponent(destinationId)}`;
				// If this hook throws, n8n's activation cleanup runs `delete` against the
				// live destination. A rate limit, an outage or a network error says nothing
				// about whether the destination exists, so keep it and its stored secret.
				let response: EvinorResponse;
				try {
					response = await evinorRequest.call(this, 'GET', path);
				} catch {
					this.logger.warn('Evinor Trigger could not check its destination (no response)');
					return true;
				}
				if (response.statusCode === 429 || response.statusCode >= 500) {
					this.logger.warn(
						`Evinor Trigger could not check its destination (status ${response.statusCode})`,
					);
					return true;
				}
				if (response.statusCode === 404) {
					return false;
				}
				if (!isSuccess(response.statusCode)) {
					throw apiError.call(this, response);
				}
				// `url` is null while the row is still waiting, which also answers false.
				return response.body.url === this.getNodeWebhookUrl('default');
			},

			async create(this: IHookFunctions): Promise<boolean> {
				// Cleared first, so any failure below leaves no stale id or secret.
				const staticData = this.getWorkflowStaticData('node');
				replaceStaticData(staticData, {});

				const url = this.getNodeWebhookUrl('default');
				if (url === undefined) {
					throw new NodeOperationError(this.getNode(), 'n8n did not provide a webhook URL');
				}

				if (this.getActivationMode() === 'manual') {
					const response = await evinorRequest.call(
						this,
						'POST',
						`${sensorPath.call(this)}/test-deliveries`,
						{ body: { url } },
					);
					if (!isSuccess(response.statusCode)) {
						throw apiError.call(this, response);
					}
					const signing = readSigningMaterial.call(this, response.body);
					replaceStaticData(staticData, { kind: 'test', ...signing });
					return true;
				}

				const response = await evinorRequest.call(
					this,
					'POST',
					`${sensorPath.call(this)}/destinations`,
					{ body: { type: 'connected_app', app: 'n8n', url } },
				);
				if (!isSuccess(response.statusCode)) {
					throw apiError.call(this, response);
				}
				const signing = readSigningMaterial.call(this, response.body);
				replaceStaticData(staticData, {
					kind: 'production',
					destinationId: response.body.id,
					...signing,
				});
				return true;
			},

			async delete(this: IHookFunctions): Promise<boolean> {
				const staticData = this.getWorkflowStaticData('node');
				const { kind, destinationId } = staticData;

				// n8n calls `delete` with the same mode for test teardown and production
				// deactivation, so the stored kind is the only safe discriminator.
				if (
					kind !== 'production' ||
					typeof destinationId !== 'string' ||
					destinationId === '' ||
					isDotSegment(destinationId)
				) {
					replaceStaticData(staticData, {});
					return true;
				}

				const path = `${sensorPath.call(this)}/destinations/${encodeURIComponent(destinationId)}`;
				try {
					const response = await evinorRequest.call(this, 'DELETE', path);
					if (!isSuccess(response.statusCode) && response.statusCode !== 404) {
						this.logger.warn(
							`Evinor Trigger could not remove its destination (status ${response.statusCode})`,
						);
						return false;
					}
				} catch (error) {
					this.logger.warn(
						`Evinor Trigger could not remove its destination: ${(error as Error).message}`,
					);
					return false;
				}

				replaceStaticData(staticData, {});
				return true;
			},
		},
	};

	async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
		let body: IDataObject;
		try {
			const { secret, keyId } = this.getWorkflowStaticData('node');
			body = this.getBodyData();
			const authentic = isAuthenticDelivery({
				body,
				signatureHeader: this.getHeaderData()['x-evinor-signature'],
				secret,
				keyId,
				nowMs: Date.now(),
			});
			if (!authentic) {
				return rejectDelivery(this);
			}
		} catch {
			return rejectDelivery(this);
		}

		// Outside the guard: a mapping failure on an authentic delivery is not a 401.
		const simplify = this.getNodeParameter('simplify', false) as boolean;
		return {
			workflowData: [this.helpers.returnJsonArray(mapEnvelopeToOutput(body, simplify))],
		};
	}
}
