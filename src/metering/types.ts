/**
 * A MeteringCalculator inspects an upstream response body and returns the
 * TRUE cost of the call (in micro-USDC, before Axon markup). The wrapper
 * engine will reconcile the difference between the estimate it already
 * debited and this real cost by issuing a compensating refund or extra debit.
 *
 * Calculators are keyed by api slug in `src/metering/index.ts`.
 */
export interface MeteringContext {
  slug: string;
  endpoint: string;
  /** The parsed upstream response body (whatever we got back). */
  responseBody: unknown;
  /** The request body the client sent (if any). */
  requestBody: unknown;
  /** The estimate we already debited (upstream cost only, before markup). */
  estimatedCostMicro: bigint;
}

export interface MeteringResult {
  /** True cost in micro-USDC, before markup. If undefined, skip reconciliation. */
  actualCostMicro?: bigint;
  /** Human-readable notes for the transaction meta field. */
  notes?: Record<string, unknown>;
}

export type MeteringCalculator = (ctx: MeteringContext) => MeteringResult;
