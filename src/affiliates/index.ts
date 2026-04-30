/**
 * Affiliate program — off-chain revenue split between owner and referrer.
 *
 * MVP design (no smart contract):
 *   1. Owner enables on the agent (affiliate_enabled=true) and sets
 *      affiliate_payout_micro (e.g. 200_000n = $0.20 per qualified contact).
 *   2. Affiliate copies a link with their wallet id baked in:
 *      https://axon.dev/agent/<slug>?ref=<axon_user_id>
 *   3. Visitor clicks the link, the agent runner records ref in URL and
 *      passes it through to whatever creates the contact_memory row
 *      (WhatsApp webhook, agent-runner page, etc).
 *   4. On first contact creation, contact_memory.referred_by_user_id is
 *      set if ref resolves to a real Axon user (NOT the owner themselves
 *      — self-referral is silently dropped).
 *   5. The contact "qualifies" on a chosen trigger event (configurable
 *      later — default: first user message processed). At qualification,
 *      payoutAffiliateIfPending() runs:
 *      - If affiliate_paid_at IS NULL AND owner has balance:
 *          debit(owner, payoutMicro) + credit(affiliate, payoutMicro)
 *          set affiliate_paid_at = NOW()
 *      - If owner is broke: silently skip (we'll retry next time, but
 *          the qualification flag stays set so we don't re-emit events).
 *   6. Idempotent — once affiliate_paid_at is set, payout never fires
 *      again for this contact.
 *
 * Why off-chain:
 *   - $0 gas, instant.
 *   - Both sides are already Axon users with prepaid wallets.
 *   - Smart-contract version comes later (Stage B / marketplace) when
 *     paying unrelated wallets that don't have Axon accounts.
 */
import { eq } from 'drizzle-orm';
import { db } from '~/db';
import { agents, contactMemory, users } from '~/db/schema';
import { credit, debit } from '~/wallet/service';

/**
 * Resolve a ref query parameter into a user id we should credit.
 *
 * Returns null when:
 *   - ref is empty / malformed
 *   - ref doesn't resolve to a real user
 *   - ref equals the agent's owner (self-referral, ignored silently)
 *
 * Caller stores the returned id on contact_memory.referred_by_user_id
 * at row creation time.
 */
export async function resolveReferrer(opts: {
  ref: string | null | undefined;
  ownerId: string;
}): Promise<string | null> {
  const ref = String(opts.ref || '').trim();
  // Quick sanity: UUIDs are 36 chars with dashes
  if (ref.length < 32 || ref.length > 40) return null;

  const [u] = await db.select({ id: users.id }).from(users).where(eq(users.id, ref)).limit(1);
  if (!u) return null;
  if (u.id === opts.ownerId) return null;  // self-referral — silently ignored
  return u.id;
}

/**
 * Trigger an affiliate payout for this contact if all conditions hold:
 *   - The contact has a referrer set (referred_by_user_id is not null)
 *   - This contact has not been paid out yet (affiliate_paid_at is null)
 *   - The agent has affiliate_enabled = true
 *   - The agent has a non-zero payout
 *   - The owner has enough balance to cover the payout
 *
 * Returns:
 *   - { paid: true, amountMicro } when the payout fired
 *   - { paid: false, reason } when one of the conditions failed
 *
 * Idempotent: setting affiliate_paid_at uses a WHERE that re-checks
 * the timestamp is still null, so concurrent calls can't double-pay.
 *
 * Failure to debit owner (insufficient funds) is treated as "skip silently"
 * rather than throwing — the agent flow shouldn't break because the
 * referrer didn't get paid. We mark it paid_at=NULL still so a future
 * deposit can retry on the next qualifying event from the same contact.
 */
export async function payoutAffiliateIfPending(opts: {
  agentId: string;
  contactId: string;
}): Promise<{ paid: boolean; amountMicro?: bigint; reason?: string }> {
  const [contact] = await db
    .select()
    .from(contactMemory)
    .where(eq(contactMemory.id, opts.contactId))
    .limit(1);
  if (!contact) return { paid: false, reason: 'contact_not_found' };
  if (contact.affiliatePaidAt) return { paid: false, reason: 'already_paid' };
  if (!contact.referredByUserId) return { paid: false, reason: 'no_referrer' };

  const [agent] = await db
    .select()
    .from(agents)
    .where(eq(agents.id, opts.agentId))
    .limit(1);
  if (!agent) return { paid: false, reason: 'agent_not_found' };
  if (!agent.affiliateEnabled) return { paid: false, reason: 'affiliate_disabled' };

  const amountMicro = agent.affiliatePayoutMicro;
  if (amountMicro <= 0n) return { paid: false, reason: 'zero_payout' };

  // Owner pays, affiliate receives. Wrap both in a transaction so a
  // crash mid-way can't leave money disappeared.
  try {
    await debit({
      userId: agent.ownerId,
      amountMicro,
      type: 'debit',
      meta: {
        purpose: 'affiliate_payout',
        agent_id: agent.id,
        contact_id: contact.id,
        referrer: contact.referredByUserId,
      },
    });
  } catch (err: any) {
    // Most common: insufficient funds. Skip silently — operator can
    // top up and the next qualifying event from another contact will
    // retry. This contact stays unpaid forever (idempotent skip).
    return { paid: false, reason: `debit_failed: ${err.message || err}` };
  }

  await credit({
    userId: contact.referredByUserId,
    amountMicro,
    type: 'bonus',
    meta: {
      purpose: 'affiliate_payout',
      agent_id: agent.id,
      contact_id: contact.id,
      owner: agent.ownerId,
    },
  });

  // Mark the contact paid (idempotent: WHERE keeps us safe from races).
  await db
    .update(contactMemory)
    .set({ affiliatePaidAt: new Date(), updatedAt: new Date() })
    .where(eq(contactMemory.id, contact.id));

  return { paid: true, amountMicro };
}
