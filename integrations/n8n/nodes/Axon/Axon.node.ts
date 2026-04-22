import {
  IExecuteFunctions,
  INodeExecutionData,
  INodeType,
  INodeTypeDescription,
  NodeOperationError,
  ILoadOptionsFunctions,
  INodePropertyOptions,
} from 'n8n-workflow';

export class Axon implements INodeType {
  description: INodeTypeDescription = {
    displayName: 'Axon',
    name: 'axon',
    icon: 'file:axon.svg',
    group: ['transform'],
    version: 1,
    subtitle: '={{$parameter["apiSlug"] + ": " + $parameter["endpoint"]}}',
    description: 'Call any API in the Axon catalog. Pay per request in USDC.',
    defaults: { name: 'Axon' },
    inputs: ['main'],
    outputs: ['main'],
    credentials: [{ name: 'axonApi', required: true }],
    properties: [
      {
        displayName: 'API',
        name: 'apiSlug',
        type: 'options',
        typeOptions: { loadOptionsMethod: 'getApis' },
        default: '',
        required: true,
        description: 'Which API in your Axon catalog to call',
      },
      {
        displayName: 'Endpoint',
        name: 'endpoint',
        type: 'options',
        typeOptions: {
          loadOptionsMethod: 'getEndpoints',
          loadOptionsDependsOn: ['apiSlug'],
        },
        default: '',
        required: true,
      },
      {
        displayName: 'Method',
        name: 'method',
        type: 'options',
        options: [
          { name: 'GET (params)', value: 'GET' },
          { name: 'POST (body)', value: 'POST' },
        ],
        default: 'GET',
        description: 'How to pass your input',
      },
      {
        displayName: 'Input (JSON)',
        name: 'input',
        type: 'json',
        default: '{}',
        description:
          'Sent as query params (GET) or JSON body (POST). Expressions and mapped fields supported.',
      },
    ],
  };

  methods = {
    loadOptions: {
      async getApis(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
        const creds = await this.getCredentials('axonApi');
        const res = await this.helpers.request({
          method: 'GET',
          url: `${creds.baseUrl}/v1/apis`,
          headers: { 'x-api-key': creds.apiKey as string },
          json: true,
        });
        return (res.data as any[]).map((a) => ({
          name: `${a.provider} — ${a.category}`,
          value: a.slug,
          description: a.description,
        }));
      },
      async getEndpoints(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
        const slug = this.getCurrentNodeParameter('apiSlug') as string;
        if (!slug) return [];
        const creds = await this.getCredentials('axonApi');
        const res = await this.helpers.request({
          method: 'GET',
          url: `${creds.baseUrl}/v1/apis/${slug}`,
          headers: { 'x-api-key': creds.apiKey as string },
          json: true,
        });
        return (res.endpoints as any[]).map((e) => ({
          name: `${e.key} (${e.method}) — $${e.effective_price_usd.toFixed(4)}`,
          value: e.key,
        }));
      },
    },
  };

  async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
    const items = this.getInputData();
    const results: INodeExecutionData[] = [];
    const creds = await this.getCredentials('axonApi');

    for (let i = 0; i < items.length; i++) {
      const slug = this.getNodeParameter('apiSlug', i) as string;
      const endpoint = this.getNodeParameter('endpoint', i) as string;
      const method = this.getNodeParameter('method', i) as 'GET' | 'POST';
      const rawInput = this.getNodeParameter('input', i) as unknown;

      const input =
        typeof rawInput === 'string' ? JSON.parse(rawInput || '{}') : rawInput;

      const url = new URL(`${creds.baseUrl}/v1/call/${slug}/${endpoint}`);
      if (method === 'GET' && typeof input === 'object' && input) {
        for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
          if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
        }
      }

      try {
        const response = await this.helpers.request({
          method,
          url: url.toString(),
          headers: { 'x-api-key': creds.apiKey as string },
          body: method === 'POST' ? input : undefined,
          json: true,
          resolveWithFullResponse: true,
        });

        results.push({
          json: {
            data: response.body,
            _axon: {
              cost_usdc: response.headers['x-axon-cost-usdc'],
              cache: response.headers['x-axon-cache'],
              latency_ms: Number(response.headers['x-axon-latency-ms'] ?? 0),
            },
          },
        });
      } catch (err: any) {
        if (this.continueOnFail()) {
          results.push({ json: { error: err.message } });
          continue;
        }
        throw new NodeOperationError(this.getNode(), err);
      }
    }

    return [results];
  }
}
