/**
 * Policy rules attached to a user (or API key).
 *
 * Evaluated pre-debit on every /v1/call. Any violation → 403 with structured
 * meta so the client can react (e.g. agent retries with a cheaper API).
 */
export interface Policy {
  /** If set, ONLY these slugs are callable. */
  allow_apis?: string[];
  /** These slugs are blocked (union with allow: deny wins). */
  deny_apis?: string[];

  /** Max micro-USDC per rolling 24h window. */
  daily_budget_micro?: string;
  /** Max micro-USDC per rolling 30d window. */
  monthly_budget_micro?: string;
  /** Hard ceiling per single request (in micro-USDC). */
  max_request_cost_micro?: string;

  /** Per-API daily caps. Keys are slugs. */
  per_api_daily_micro?: Record<string, string>;

  /** If true, cache hits bypass budget counting (default: false). */
  exclude_cache_from_budget?: boolean;

  /** Optional human-readable label for dashboards. */
  label?: string;
}
