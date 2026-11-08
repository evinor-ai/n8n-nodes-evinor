import type {
	IAuthenticateGeneric,
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

export class EvinorApi implements ICredentialType {
	name = 'evinorApi';

	displayName = 'Evinor API';

	icon = {
		light: 'file:../nodes/EvinorTrigger/evinor.svg',
		dark: 'file:../nodes/EvinorTrigger/evinor.dark.svg',
	} as const;

	documentationUrl = 'https://github.com/evinor-ai/n8n-nodes-evinor#credentials';

	properties: INodeProperties[] = [
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			required: true,
			description: 'An Evinor API key with the SENSORS_READ and SENSORS_WRITE scopes',
		},
		{
			displayName: 'Base URL',
			name: 'baseUrl',
			type: 'string',
			default: 'https://api.evinor.ai',
			required: true,
			description:
				'The Evinor API origin. Change it only to test against another Evinor environment.',
		},
	];

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				Authorization: '=Bearer {{$credentials.apiKey}}',
			},
		},
	};

	test: ICredentialTestRequest = {
		request: {
			baseURL: '={{$credentials.baseUrl}}',
			url: '/v1/sensors',
			method: 'GET',
		},
	};
}
