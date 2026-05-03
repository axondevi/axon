/**
 * Usage tracking — increments per-agent subscription counters used by
 * the monthly billing cron to compute overage charges.
 *
 * Fire-and-forget: never throws or blocks the caller. If the agent has
 * no subscription row yet, the increment is silently skipped (the agent
 * is in "trial / unpaid" state and overage doesn't apply).
 *
 * Atomic SQL UPDATE so concurrent webhook turns don't race.
 */
import { sql, eq } from 'drizzle-orm';
import { db } from '~/db';
import { agentSubscriptions } from '~/db/schema';
import { log } from '~/lib/logger';

type Counter = 'turns' | 'vision' | 'pdf' | 'reminders';

const COL: Record<Counter, any> = {
  turns: agentSubscriptions.usedTurns,
  vision: agentSubscriptions.usedVision,
  pdf: agentSubscriptions.usedPdf,
  reminders: agentSubscriptions.usedReminders,
};

/**
 * Increment a counter on the agent's subscription. Returns nothing —
 * fire-and-forget by design.
 *
 *   await trackUsage('agent-id', 'turns', 1);
 */
export async function trackUsage(
  agentId: string | undefined | null,
  counter: Counter,
  delta = 1,
): Promise<void> {
  if (!agentId) return;
  if (delta === 0) return;
  try {
    const col = COL[counter];
    await db
      .update(agentSubscriptions)
      .set({
        [counter === 'turns' ? 'usedTurns' :
          counter === 'vision' ? 'usedVision' :
          counter === 'pdf' ? 'usedPdf' :
          'usedReminders']: sql`${col} + ${delta}`,
        updatedAt: new Date(),
      })
      .where(eq(agentSubscriptions.agentId, agentId));
  } catch (err: any) {
    log.warn('usage_tracking_failed', {
      agent_id: agentId,
      counter,
      error: err?.message || String(err),
    });
  }
}

/** Convenience wrapper for the common case of +1. */
export const trackTurn = (agentId?: string | null) => trackUsage(agentId, 'turns', 1);
export const trackVision = (agentId?: string | null) => trackUsage(agentId, 'vision', 1);
export const trackPdf = (agentId?: string | null) => trackUsage(agentId, 'pdf', 1);
export const trackReminder = (agentId?: string | null) => trackUsage(agentId, 'reminders', 1);
