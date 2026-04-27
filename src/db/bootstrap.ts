/**
 * Idempotent DB bootstrap — ensures required system rows exist.
 *
 * Runs at server startup. Creates the "x402 anonymous" user used to log
 * requests paid directly on-chain (no authed wallet), the "demo" system
 * user that owns all public demo agents, and one demo agent per template
 * so any visitor can chat without signing up.
 */
import { sql } from 'drizzle-orm';
import { db } from './index';
import { users, wallets, agents } from './schema';
import { AGENT_TEMPLATES } from '~/agents/templates';

/** Fixed UUID for the synthetic user that represents all x402-native calls. */
export const X402_ANON_USER_ID = '00000000-0000-0000-0000-000000000000';

/** Fixed UUID for the system user that OWNS all demo agents (pays for visitor chat). */
export const DEMO_SYSTEM_USER_ID = '00000000-0000-0000-0000-000000000001';

/** Initial demo wallet balance in micro-USDC. $100 covers ~10k chat turns. */
const DEMO_WALLET_INITIAL_MICRO = 100_000_000n;

/** Daily budget per demo agent in micro-USDC. $10/day = ~1000 conversations. */
const DEMO_AGENT_DAILY_BUDGET_MICRO = 10_000_000n;

export async function ensureSystemRows() {
  // ─── X402 anonymous user (legacy) ───────────────────────────
  await db
    .insert(users)
    .values({
      id: X402_ANON_USER_ID,
      email: 'x402-anonymous@axon.system',
      apiKeyHash: 'x402-anonymous',
      tier: 'free',
    })
    .onConflictDoNothing();

  await db
    .insert(wallets)
    .values({
      userId: X402_ANON_USER_ID,
      address: '0x0000000000000000000000000000000000000001',
      balanceMicro: 0n,
      reservedMicro: 0n,
    })
    .onConflictDoNothing();

  // ─── Demo system user + wallet (owns all public demo agents) ──
  await db
    .insert(users)
    .values({
      id: DEMO_SYSTEM_USER_ID,
      email: 'demo@axon.system',
      apiKeyHash: 'demo-system-no-key-needed',
      tier: 'team',  // unlock all template tiers
    })
    .onConflictDoNothing();

  await db
    .insert(wallets)
    .values({
      userId: DEMO_SYSTEM_USER_ID,
      address: '0x0000000000000000000000000000000000000002',
      balanceMicro: DEMO_WALLET_INITIAL_MICRO,
      reservedMicro: 0n,
    })
    .onConflictDoNothing();

  // Top up demo wallet if it's been drained (covers ongoing demo usage).
  // This runs every boot, so the wallet stays funded as long as the service redeploys.
  await db.execute(sql`
    UPDATE wallets
    SET balance_micro = GREATEST(balance_micro, ${DEMO_WALLET_INITIAL_MICRO})
    WHERE user_id = ${DEMO_SYSTEM_USER_ID}
  `);

  // ─── Seed one demo agent per template ───────────────────────
  // Each gets slug "demo-{template.id}", pay_mode='owner' so visitors chat for free,
  // and a daily budget covered by the demo wallet.
  for (const tpl of AGENT_TEMPLATES) {
    const slug = `demo-${tpl.id}`;
    await db
      .insert(agents)
      .values({
        ownerId: DEMO_SYSTEM_USER_ID,
        slug,
        name: `${tpl.name} (Demo)`,
        description: tpl.description,
        systemPrompt: tpl.systemPrompt,
        allowedTools: tpl.tools,
        primaryColor: tpl.primaryColor,
        welcomeMessage: tpl.welcomeMessage,
        quickPrompts: tpl.quickPrompts,
        public: true,
        template: tpl.id,
        payMode: 'owner',
        dailyBudgetMicro: DEMO_AGENT_DAILY_BUDGET_MICRO,
        tierRequired: 'free',
        budgetPerSession: 500_000n,
        hardCap: 2_000_000n,
        uiLanguage: 'auto',
      })
      .onConflictDoNothing();
  }

  // Touch the row so timestamps refresh if someone queries health.
  await db.execute(sql`SELECT 1`);
}
