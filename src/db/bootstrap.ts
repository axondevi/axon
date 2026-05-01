/**
 * Idempotent DB bootstrap — ensures required system rows exist.
 *
 * Runs at server startup. Creates the "x402 anonymous" user used to log
 * requests paid directly on-chain (no authed wallet), the "demo" system
 * user that owns all public demo agents, and one demo agent per template
 * so any visitor can chat without signing up.
 */
import { sql } from 'drizzle-orm';
import { eq } from 'drizzle-orm';
import { db } from './index';
import { users, wallets, agents, personas } from './schema';
import { AGENT_TEMPLATES } from '~/agents/templates';
import { PERSONA_SEEDS } from '~/personas/seeds';

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

  // 0010: pix_payments — Pix lifecycle for MercadoPago integration.
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "pix_payments" (
      "id"                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "user_id"              uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
      "mp_payment_id"        text NOT NULL,
      "amount_brl"           numeric(12, 2) NOT NULL,
      "amount_usdc_micro"    bigint,
      "fx_rate_brl_per_usd"  numeric(8, 4),
      "status"               text NOT NULL DEFAULT 'pending',
      "qr_code"              text,
      "qr_code_base64"       text,
      "ticket_url"           text,
      "approved_at"          timestamp,
      "expires_at"           timestamp,
      "meta"                 jsonb,
      "created_at"           timestamp NOT NULL DEFAULT NOW(),
      "updated_at"           timestamp NOT NULL DEFAULT NOW()
    )
  `);
  await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS "pix_mp_id_idx" ON "pix_payments" ("mp_payment_id")`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS "pix_user_idx" ON "pix_payments" ("user_id")`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS "pix_status_idx" ON "pix_payments" ("status")`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS "pix_created_idx" ON "pix_payments" ("created_at" DESC)`);

  // 0011: personas + agents.persona_id — AI characters.
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "personas" (
      "id"                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "slug"                     text NOT NULL,
      "name"                     text NOT NULL,
      "tagline"                  text,
      "emoji"                    text,
      "tone_description"         text NOT NULL,
      "prompt_fragment"          text NOT NULL,
      "sample_greeting"          text,
      "sample_signoff"           text,
      "voice_id_elevenlabs"      text,
      "avatar_color_primary"     text NOT NULL DEFAULT '#7c5cff',
      "avatar_color_secondary"   text NOT NULL DEFAULT '#19d5c6',
      "premium"                  boolean NOT NULL DEFAULT false,
      "monthly_price_brl"        integer NOT NULL DEFAULT 0,
      "active"                   boolean NOT NULL DEFAULT true,
      "display_order"            integer NOT NULL DEFAULT 100,
      "created_at"               timestamp NOT NULL DEFAULT NOW(),
      "updated_at"               timestamp NOT NULL DEFAULT NOW()
    )
  `);
  await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS "personas_slug_idx" ON "personas" ("slug")`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS "personas_active_idx" ON "personas" ("active")`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS "personas_order_idx" ON "personas" ("display_order")`);
  await db.execute(sql`ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "persona_id" uuid REFERENCES "personas"("id") ON DELETE SET NULL`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS "agents_persona_idx" ON "agents" ("persona_id")`);

  // 0012: smart routing — agents that act as a router classify inbound
  // intent and forward to a specialized agent. routes_to + routed_agent_id
  // + route_intent are all nullable, so existing rows are unaffected.
  // Must be in ensureCriticalSchema (not ensureSystemRows) because
  // SELECT * from agents now references routes_to — without this DDL the
  // first /v1/agents request would 500 with "column does not exist".
  await db.execute(sql`ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "routes_to" jsonb`);
  await db.execute(sql`ALTER TABLE "contact_memory" ADD COLUMN IF NOT EXISTS "routed_agent_id" uuid`);
  await db.execute(sql`ALTER TABLE "contact_memory" ADD COLUMN IF NOT EXISTS "route_intent" text`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS "contact_memory_routed_agent_idx" ON "contact_memory" ("routed_agent_id")`);

  // 0013: affiliate program (off-chain MVP). Same idempotency pattern as
  // 0012 — both are SELECT-* paths. Owner toggles `affiliate_enabled` and
  // sets `affiliate_payout_micro` (USDC micro-units) per qualified new
  // contact. contact_memory tracks who referred + when paid (idempotent).
  await db.execute(sql`ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "affiliate_enabled" boolean NOT NULL DEFAULT false`);
  await db.execute(sql`ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "affiliate_payout_micro" bigint NOT NULL DEFAULT 0`);
  await db.execute(sql`ALTER TABLE "contact_memory" ADD COLUMN IF NOT EXISTS "referred_by_user_id" uuid`);
  await db.execute(sql`ALTER TABLE "contact_memory" ADD COLUMN IF NOT EXISTS "affiliate_paid_at" timestamp`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS "contact_memory_referred_by_idx" ON "contact_memory" ("referred_by_user_id") WHERE "referred_by_user_id" IS NOT NULL`);

  // 0014: pause + handoff. agents.paused_at mutes the bot on every channel
  // until cleared. contact_memory.human_paused_until lets the owner take
  // over a single conversation for N minutes without disabling the agent
  // globally. Both nullable so existing rows are unaffected. SELECT * paths
  // touch these columns so they MUST be in ensureCriticalSchema.
  await db.execute(sql`ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "paused_at" timestamp`);
  await db.execute(sql`ALTER TABLE "contact_memory" ADD COLUMN IF NOT EXISTS "human_paused_until" timestamp`);

  // 0015: business_info — free-text reference (address, hours, prices) the
  // owner wants the agent to know. Plumbed into the system prompt at runtime.
  // SELECT * paths reference it, so DDL goes here.
  await db.execute(sql`ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "business_info" text`);

  // 0016: requests.agent_id was added in migration 0004 without a foreign
  // key. Add ON DELETE SET NULL so deleting an agent leaves request history
  // intact for accounting/analytics rather than orphaning rows that violate
  // referential integrity. We DO NOT use CASCADE — operator may need the
  // request audit trail even after deletion. The constraint name lets us
  // skip if it already exists (Postgres lacks "IF NOT EXISTS" on FK).
  await db.execute(sql`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'requests_agent_id_fkey'
      ) THEN
        ALTER TABLE "requests"
          ADD CONSTRAINT "requests_agent_id_fkey"
          FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE SET NULL;
      END IF;
    END $$
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS "whatsapp_connections_owner_idx" ON "whatsapp_connections" ("owner_id")`);

  // 0017: settlement uniqueness. Concurrent settle jobs (manual retry +
  // scheduled) used to SELECT-then-INSERT and produce duplicate rows
  // for the same (api, period). The unique index lets the upsert path
  // use ON CONFLICT DO UPDATE atomically.
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS "settlement_period_idx"
      ON "settlements" ("api_slug", "period_start", "period_end")
  `);
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

  // ─── Seed personas (idempotent on slug) ──────────────────────
  // We only INSERT new slugs and UPDATE existing rows' content (so when
  // we tweak a prompt fragment, every redeploy refreshes it). Owner-set
  // overrides via SQL can use display_order < 0 to opt out, or just
  // edit the columns directly — the upsert won't override them since
  // we ON CONFLICT DO NOTHING.
  for (const p of PERSONA_SEEDS) {
    await db
      .insert(personas)
      .values({
        slug: p.slug,
        name: p.name,
        tagline: p.tagline,
        emoji: p.emoji,
        toneDescription: p.toneDescription,
        promptFragment: p.promptFragment,
        sampleGreeting: p.sampleGreeting,
        sampleSignoff: p.sampleSignoff,
        voiceIdElevenlabs: p.voiceIdElevenlabs,
        avatarColorPrimary: p.avatarColorPrimary,
        avatarColorSecondary: p.avatarColorSecondary,
        displayOrder: p.displayOrder,
      })
      .onConflictDoNothing();
  }

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
