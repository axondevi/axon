import {
  ICredentialType,
  INodeProperties,
  ICredentialTestRequest,
} from 'n8n-workflow';

export class AxonApi implements ICredentialType {
  name = 'axonApi';
  displayName = 'Axon API';
  documentationUrl = 'https://docs.axon.dev';

  properties: INodeProperties[] = [
    {
      displayName: 'API Key',
      name: 'apiKey',
      type: 'string',
      typeOptions: { password: true },
      default: '',
      description: 'Your Axon API key — starts with ax_live_',
      required: true,
    },
    {
      displayName: 'Base URL',
      name: 'baseUrl',
      type: 'string',
      default: 'https://axon-kedb.onrender.com',
      description: 'Override for self-hosted deployments',
    },
  ];

  test: ICredentialTestRequest = {
    request: {
      baseURL: '={{$credentials.baseUrl}}',
      url: '/v1/wallet/balance',
      headers: { 'x-api-key': '={{$credentials.apiKey}}' },
    },
  };
}
