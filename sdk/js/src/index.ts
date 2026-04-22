/**
 * Axon — JavaScript / TypeScript client
 *
 *   import { Axon } from '@axon/client';
 *
 *   const axon = new Axon({ apiKey: process.env.AXON_KEY });
 *
 *   const { data } = await axon.call('serpapi', 'search', { q: 'espresso' });
 *   console.log(axon.lastCost, axon.lastCacheHit);
 *
 *   const balance = await axon.wallet.balance();
 */

export interface AxonOptions {
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  userAgent?: string;
}

export interface CallResult<T = unknown> {
  data: T;
  costUsdc: string;
  cacheHit: boolean;
  latencyMs: number;
  status: number;
  headers: Record<string, string>;
}

export interface WalletBalance {
  address: string;
  balance_usdc: string;
  reserved_usdc: string;
  available_usdc: string;
}

export interface UsageSummary {
  total_requests: number;
  cache_hits: number;
  cache_hit_rate: number;
  total_spent_usdc: string;
}

export interface ApiCatalogEntry {
  slug: string;
  provider: string;
  category: string;
  description: string;
  homepage?: string;
  endpoints: string[];
}

export class AxonError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public meta?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AxonError';
  }
}

export class Axon {
  private apiKey: string;
  private baseUrl: string;
  private fetchImpl: typeof fetch;
  private userAgent: string;

  public lastCost = '0';
  public lastCacheHit = false;
  public lastLatencyMs = 0;

  public readonly wallet: WalletClient;
  public readonly apis: CatalogClient;
  public readonly usage: UsageClient;

  constructor(opts: AxonOptions) {
    if (!opts.apiKey) throw new Error('Axon: apiKey is required');
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? 'https://api.axon.dev').replace(/\/$/, '');
    this.fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.userAgent = opts.userAgent ?? '@axon/client/0.1';

    this.wallet = new WalletClient(this);
    this.apis = new CatalogClient(this);
    this.usage = new UsageClient(this);
  }

  /** Internal: authenticated request helper */
  async _req<T = unknown>(
    path: string,
    init: RequestInit = {},
  ): Promise<{ body: T; status: number; headers: Record<string, string> }> {
    const url = `${this.baseUrl}${path}`;
    const headers = new Headers(init.headers);
    headers.set('x-api-key', this.apiKey);
    headers.set('user-agent', this.userAgent);
    if (init.body && !headers.has('content-type')) {
      headers.set('content-type', 'application/json');
    }

    const res = await this.fetchImpl(url, { ...init, headers });
    const text = await res.text();
    const headerObj: Record<string, string> = {};
    res.headers.forEach((v, k) => (headerObj[k] = v));

    let parsed: any;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }

    if (!res.ok) {
      throw new AxonError(
        res.status,
        parsed?.error ?? 'http_error',
        parsed?.message ?? `HTTP ${res.status}`,
        parsed?.meta,
      );
    }

    return { body: parsed as T, status: res.status, headers: headerObj };
  }

  /**
   * Call an API in the Axon catalog.
   *
   *   await axon.call('serpapi', 'search', { q: 'espresso' })
   *   await axon.call('openai', 'chat', undefined, { messages: [...] })
   */
  async call<T = unknown>(
    slug: string,
    endpoint: string,
    params?: Record<string, string | number | boolean>,
    body?: unknown,
  ): Promise<CallResult<T>> {
    const qs = params
      ? '?' +
        new URLSearchParams(
          Object.entries(params).map(([k, v]) => [k, String(v)]),
        ).toString()
      : '';
    const path = `/v1/call/${slug}/${endpoint}${qs}`;

    const init: RequestInit = {
      method: body !== undefined ? 'POST' : 'GET',
    };
    if (body !== undefined) init.body = JSON.stringify(body);

    const { body: data, status, headers } = await this._req<T>(path, init);

    const costUsdc = headers['x-axon-cost-usdc'] ?? '0';
    const cacheHit = headers['x-axon-cache'] === 'hit';
    const latencyMs = Number(headers['x-axon-latency-ms'] ?? 0);

    this.lastCost = costUsdc;
    this.lastCacheHit = cacheHit;
    this.lastLatencyMs = latencyMs;

    return { data, costUsdc, cacheHit, latencyMs, status, headers };
  }
}

export class WalletClient {
  constructor(private axon: Axon) {}

  async balance(): Promise<WalletBalance> {
    const { body } = await this.axon._req<WalletBalance>('/v1/wallet/balance');
    return body;
  }

  async transactions(limit = 50) {
    const { body } = await this.axon._req<{ data: unknown[] }>(
      `/v1/wallet/transactions?limit=${limit}`,
    );
    return body.data;
  }

  async depositIntent(): Promise<{
    chain: string;
    asset: string;
    asset_address: string;
    deposit_address: string;
    note: string;
  }> {
    const { body } = await this.axon._req('/v1/wallet/deposit-intent', {
      method: 'POST',
    });
    return body as any;
  }
}

export class CatalogClient {
  constructor(private axon: Axon) {}

  async list(): Promise<ApiCatalogEntry[]> {
    const { body } = await this.axon._req<{ data: ApiCatalogEntry[] }>('/v1/apis');
    return body.data;
  }

  async get(slug: string) {
    const { body } = await this.axon._req(`/v1/apis/${slug}`);
    return body;
  }
}

export class UsageClient {
  constructor(private axon: Axon) {}

  async summary(opts?: { from?: string; to?: string; api?: string }): Promise<UsageSummary> {
    const qs = new URLSearchParams();
    if (opts?.from) qs.set('from', opts.from);
    if (opts?.to) qs.set('to', opts.to);
    if (opts?.api) qs.set('api', opts.api);
    const tail = qs.toString() ? `?${qs}` : '';
    const { body } = await this.axon._req<UsageSummary>(`/v1/usage${tail}`);
    return body;
  }

  async byApi() {
    const { body } = await this.axon._req<{ data: unknown[] }>('/v1/usage/by-api');
    return body.data;
  }
}

export default Axon;
