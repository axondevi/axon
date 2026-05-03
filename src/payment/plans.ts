/**
 * Subscription plans and overage rates for per-agent billing.
 *
 * All prices in USDC (priced in USD, paid in USDC on Base). Stored as
 * micro-units (6 decimals) to match the wallet ledger semantics.
 *
 * Pricing intent (decided 2026-05-02):
 *   - Starter $40/mo covers 90% of clinic / SMB usage out of the box.
 *   - Pro $100/mo covers active e-commerce / multi-attendant clinics.
 *   - Overage rates are intentionally high markup (15-100x raw cost):
 *     turns/vision/pdf calls cost us a fraction of a cent each; the
 *     overage rate captures real margin from power users without
 *     pushing average customers above their plan price.
 *
 * Grace period: 5 days after a failed monthly debit. Agent KEEPS RUNNING
 * during grace so a customer doesn't lose business while the owner tops
 * up. After 5 days the agent is paused (status=cancelled).
 */

export const GRACE_PERIOD_DAYS = 5;

export interface PlanIncluded {
  /** WhatsApp turns (LLM responses sent). */
  turns: number;
  /** Vision describes (photo + PDF describes via Gemini). */
  vision: number;
  /** PDFs the agent generated via generate_pdf. */
  pdf: number;
  /** Daily appointment reminders dispatched. */
  reminders: number;
  /** Storage cap in GB (for owner UI; not actively enforced yet). */
  storage_gb: number;
}

export interface Plan {
  /** Internal id. */
  id: 'starter' | 'pro';
  /** Display name in UI. */
  name: string;
  /** Monthly price in USDC micro-units (6 decimals). */
  price_micro: bigint;
  /** Display price in USD. */
  price_usd: number;
  /** What's included before overage kicks in. */
  included: PlanIncluded;
}

export const PLANS: Record<Plan['id'], Plan> = {
  starter: {
    id: 'starter',
    name: 'Starter',
    price_micro: 40_000_000n,  // $40 = 40 * 1e6 micro-USDC
    price_usd: 40,
    included: {
      turns: 5_000,
      vision: 500,
      pdf: 200,
      reminders: 1_000,
      storage_gb: 1,
    },
  },
  pro: {
    id: 'pro',
    name: 'Pro',
    price_micro: 100_000_000n,  // $100
    price_usd: 100,
    included: {
      turns: 25_000,
      vision: 5_000,
      pdf: 1_000,
      reminders: 5_000,
      storage_gb: 5,
    },
  },
};

export const DEFAULT_PLAN: Plan['id'] = 'starter';

/**
 * Overage rates per unit, in USDC micro. Charged on the next monthly
 * debit when usage exceeds the plan's included amount.
 *
 * Markup commentary (raw upstream cost vs charged):
 *   turn       — Groq llama-3.3-70b ~$0.0007/turn  → charged $0.01    → 14x
 *   vision     — Gemini 2.5 Flash Lite ~$0.0001    → charged $0.10    → 1000x
 *   pdf        — pdfkit local + Evolution send ~$0 → charged $0.05    → infinite (paying for the artifact)
 *   reminder   — Evolution sendText ~$0            → charged $0.01    → infinite (covers SMS/WA infra cost)
 *
 * High markup is intentional: the included tier covers normal use; only
 * power users hit overage and they're already locked-in.
 */
export const OVERAGE = {
  /** $0.01 per turn above included. */
  turn_micro: 10_000n,
  /** $0.10 per vision describe above included. */
  vision_micro: 100_000n,
  /** $0.05 per PDF generated above included. */
  pdf_micro: 50_000n,
  /** $0.01 per appointment reminder above included. */
  reminder_micro: 10_000n,
} as const;

/**
 * Calculate the total amount to debit for a billing period.
 *
 * total = plan.price + sum_of_overages
 *
 * Returns micro-units (matches wallet ledger).
 */
export function computeBillAmountMicro(opts: {
  plan: Plan['id'];
  used_turns: number;
  used_vision: number;
  used_pdf: number;
  used_reminders: number;
}): { total_micro: bigint; breakdown: { base_micro: bigint; overage: { turns_micro: bigint; vision_micro: bigint; pdf_micro: bigint; reminders_micro: bigint } } } {
  const plan = PLANS[opts.plan] ?? PLANS[DEFAULT_PLAN];

  const overTurns = Math.max(0, opts.used_turns - plan.included.turns);
  const overVision = Math.max(0, opts.used_vision - plan.included.vision);
  const overPdf = Math.max(0, opts.used_pdf - plan.included.pdf);
  const overReminders = Math.max(0, opts.used_reminders - plan.included.reminders);

  const turnsCharge = BigInt(overTurns) * OVERAGE.turn_micro;
  const visionCharge = BigInt(overVision) * OVERAGE.vision_micro;
  const pdfCharge = BigInt(overPdf) * OVERAGE.pdf_micro;
  const remindersCharge = BigInt(overReminders) * OVERAGE.reminder_micro;

  const total = plan.price_micro + turnsCharge + visionCharge + pdfCharge + remindersCharge;

  return {
    total_micro: total,
    breakdown: {
      base_micro: plan.price_micro,
      overage: {
        turns_micro: turnsCharge,
        vision_micro: visionCharge,
        pdf_micro: pdfCharge,
        reminders_micro: remindersCharge,
      },
    },
  };
}
