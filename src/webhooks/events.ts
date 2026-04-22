/**
 * Outbound webhook events that Axon emits.
 *
 * Event name conventions: `noun.verb` (past tense).
 * Stable contract — adding fields is OK, removing them is not (version bumps).
 */
export type WebhookEvent =
  | 'deposit.received'
  | 'balance.low'
  | 'policy.denied'
  | 'call.refunded'
  | 'rate_limit.hit'
  | 'wallet.reserved_exceeds_balance';

export interface WebhookPayload<T = unknown> {
  id: string;           // unique event id (uuid) — use for idempotency
  event: WebhookEvent;
  created_at: string;   // ISO timestamp
  user_id: string;
  data: T;
}

export interface DepositReceivedData {
  amount_usdc: string;
  new_balance_usdc: string;
  onchain_tx: string | null;
}

export interface BalanceLowData {
  balance_usdc: string;
  threshold_usdc: string;
}

export interface PolicyDeniedData {
  rule: string;
  api_slug: string;
  endpoint: string;
  meta: Record<string, unknown>;
}

export interface CallRefundedData {
  api_slug: string;
  endpoint: string;
  amount_refunded_usdc: string;
  reason: string;
}

export interface RateLimitHitData {
  limit: number;
  retry_after_sec: number;
  tier: string;
}
