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

/**
 * Schema changes that the code DEPENDS ON. These MUST run before the server
 * starts answering requests, otherwise Drizzle queries that reference newly-
 * added columns will fail with "column does not exist".
 *
 * Keep this function FAST (just DDL, no data) so cold-start stays snappy.
 * Idempotent — every statement uses IF NOT EXISTS.
 *
 * Slow seed work (demo agents, wallet top-up) goes in `ensureSystemRows`
 * which still runs fire-and-forget after the server is up.
 */
export async function ensureCriticalSchema() {
  // 0009: agents.owner_phone — when set, an inbound WhatsApp message from this
  // number flips the agent into personal-assistant mode for the owner.
  await db.execute(sql`ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "owner_phone" text`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS "agents_owner_phone_idx" ON "agents" ("owner_phone")`);
}

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

  // ─── Self-healing schema: ensure agent_cache exists ─────────
  // Migration 0007_agent_cache.sql may not have been applied if the operator
  // skipped `db:migrate`. This block is idempotent — it makes Render
  // auto-deploys "just work" without manual intervention.
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "agent_cache" (
      "id"                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "agent_id"           uuid NOT NULL REFERENCES "agents"("id") ON DELETE CASCADE,
      "query_text"         text NOT NULL,
      "query_embedding"    jsonb NOT NULL,
      "response_text"      text NOT NULL,
      "hits"               integer NOT NULL DEFAULT 0,
      "last_hit"           timestamp NOT NULL DEFAULT NOW(),
      "cost_saved_micro"   bigint NOT NULL DEFAULT 0,
      "created_at"         timestamp NOT NULL DEFAULT NOW()
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS "agent_cache_agent_idx" ON "agent_cache" ("agent_id")`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS "agent_cache_lasthit_idx" ON "agent_cache" ("last_hit" DESC)`);

  // ─── Self-healing schema: ensure contact_memory exists ──────
  // Migration 0008_contact_memory.sql may not have been applied if the operator
  // skipped `db:migrate`. Idempotent block so Render auto-deploys "just work".
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "contact_memory" (
      "id"                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "agent_id"           uuid NOT NULL REFERENCES "agents"("id") ON DELETE CASCADE,
      "phone"              text NOT NULL,
      "display_name"       text,
      "language"           text NOT NULL DEFAULT 'pt-br',
      "formality"          text NOT NULL DEFAULT 'auto',
      "tags"               jsonb NOT NULL DEFAULT '[]'::jsonb,
      "facts"              jsonb NOT NULL DEFAULT '[]'::jsonb,
      "summary"            text,
      "message_count"      integer NOT NULL DEFAULT 0,
      "first_contact_at"   timestamp NOT NULL DEFAULT NOW(),
      "last_contact_at"    timestamp NOT NULL DEFAULT NOW(),
      "created_at"         timestamp NOT NULL DEFAULT NOW(),
      "updated_at"         timestamp NOT NULL DEFAULT NOW(),
      CONSTRAINT "contact_memory_agent_phone_unique" UNIQUE ("agent_id", "phone")
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS "contact_memory_agent_idx" ON "contact_memory" ("agent_id")`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS "contact_memory_last_contact_idx" ON "contact_memory" ("last_contact_at" DESC)`);

  // Touch the row so timestamps refresh if someone queries health.
  await db.execute(sql`SELECT 1`);
}
