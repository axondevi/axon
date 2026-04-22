export type AuthType =
  | { type: 'header'; name: string; prefix?: string }
  | { type: 'query'; name: string }
  | { type: 'bearer' }
  | { type: 'none' };

export interface EndpointConfig {
  /** HTTP method */
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Path template on upstream, e.g. "/search" or "/v1/chat/completions" */
  path: string;
  /** Base price in USD charged per successful call */
  price_usd: number;
  /** Our markup % on top of upstream price (e.g. 10) */
  markup_pct: number;
  /** Cache TTL in seconds; 0 = no cache */
  cache_ttl: number;
  /** Whether request body (for POST) should be hashed into cache key */
  cache_on_body?: boolean;
  /**
   * Optional: other {slug, endpoint} pairs to try if this one fails or times
   * out. First match wins. Applied in order.
   *
   *   "fallbacks": [{"slug": "serper", "endpoint": "search"}]
   */
  fallbacks?: Array<{ slug: string; endpoint: string }>;
  /**
   * Optional: ms before we give up and try a fallback (default: no timeout).
   */
  timeout_ms?: number;
  /** Optional: idempotency hints, max cost cap, etc. */
  notes?: string;
}

export interface ApiConfig {
  slug: string;
  provider: string;
  category: string;
  description: string;
  homepage?: string;
  base_url: string;
  auth: AuthType;
  endpoints: Record<string, EndpointConfig>;
}
