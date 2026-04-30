import { sql } from 'drizzle-orm';
import {
  pgTable,
  uuid,
  text,
  timestamp,
  bigint,
  boolean,
  jsonb,
  integer,
  numeric,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

// ─── Users ────────────────────────────────────────────
// `tier` is the *active* plan. Once tierExpiresAt elapses, callers
// (auth middleware, engine) should treat the effective tier as 'free'.
// The DB row is only rewritten by the renewal cron — keeping the historical
// tier on disk simplifies billing reports and idempotent re-activations.
export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email'),
    apiKeyHash: text('api_key_hash').notNull(),
    tier: text('tier').notNull().default('free'),
    tierExpiresAt: timestamp('tier_expires_at'),
    tierAutoRenew: boolean('tier_auto_renew').notNull().default(true),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => ({
    apiKeyIdx: uniqueIndex('users_api_key_idx').on(t.apiKeyHash),
    emailIdx: uniqueIndex('users_email_idx').on(t.email),
    tierExpIdx: index('users_tier_exp_idx').on(t.tierExpiresAt),
  }),
);

// ─── Wallets (USDC, micro units = 6 decimals) ─────────
export const wallets = pgTable('wallets', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  address: text('address').notNull().unique(),
  balanceMicro: bigint('balance_micro', { mode: 'bigint' })
    .notNull()
    .default(0n),
  reservedMicro: bigint('reserved_micro', { mode: 'bigint' })
    .notNull()
    .default(0n),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// ─── Transactions (ledger) ────────────────────────────
// type: deposit | debit | refund | withdrawal | bonus
export const transactions = pgTable(
  'transactions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    amountMicro: bigint('amount_micro', { mode: 'bigint' }).notNull(),
    apiSlug: text('api_slug'),
    requestId: uuid('request_id'),
    onchainTx: text('onchain_tx'),
    meta: jsonb('meta'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => ({
    userIdx: index('tx_user_idx').on(t.userId),
    createdIdx: index('tx_created_idx').on(t.createdAt),
    onchainIdx: uniqueIndex('tx_onchain_idx')
      .on(t.onchainTx)
      .where(sql`${t.onchainTx} IS NOT NULL`),
  }),
);

// ─── API registry (catalog) ───────────────────────────
export const apiRegistry = pgTable('api_registry', {
  slug: text('slug').primaryKey(),
  provider: text('provider').notNull(),
  category: text('category').notNull(),
  baseUrl: text('base_url').notNull(),
  config: jsonb('config').notNull(),
  active: boolean('active').notNull().default(true),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// ─── Requests (usage log) ─────────────────────────────
export const requests = pgTable(
  'requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    apiSlug: text('api_slug').notNull(),
    endpoint: text('endpoint').notNull(),
    costMicro: bigint('cost_micro', { mode: 'bigint' }).notNull(),
    markupMicro: bigint('markup_micro', { mode: 'bigint' }).notNull(),
    cacheHit: boolean('cache_hit').notNull().default(false),
    latencyMs: integer('latency_ms'),
    status: integer('status'),
    // Set when this request was made on behalf of a custom agent
    // (via /v1/run/:slug/...). Drives /v1/agents/:id/analytics.
    agentId: uuid('agent_id'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => ({
    userIdx: index('req_user_idx').on(t.userId),
    apiIdx: index('req_api_idx').on(t.apiSlug),
    createdIdx: index('req_created_idx').on(t.createdAt),
    agentIdx: index('req_agent_idx').on(t.agentId),
  }),
);

// ─── Policies (budgets, allow/deny lists) ─────────────
export const policies = pgTable('policies', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  rules: jsonb('rules').notNull(), // Policy (see src/policy/types.ts)
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// ─── Settlements (what we owe each upstream) ──────────
// status: pending | paid | reconciled
export const settlements = pgTable(
  'settlements',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    apiSlug: text('api_slug').notNull(),
    periodStart: timestamp('period_start').notNull(),
    periodEnd: timestamp('period_end').notNull(),
    requestCount: integer('request_count').notNull(),
    owedMicro: bigint('owed_micro', { mode: 'bigint' }).notNull(),
    status: text('status').notNull().default('pending'),
    paidAt: timestamp('paid_at'),
    paidRef: text('paid_ref'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => ({
    apiIdx: index('settlement_api_idx').on(t.apiSlug),
    statusIdx: index('settlement_status_idx').on(t.status),
  }),
);

// ─── Outbound webhooks (subscriptions) ─────────────────
export const webhookSubscriptions = pgTable(
  'webhook_subscriptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    url: text('url').notNull(),
    events: jsonb('events').notNull(), // string[]
    secret: text('secret').notNull(), // HMAC-SHA256 signing key
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => ({
    userIdx: index('webhook_user_idx').on(t.userId),
  }),
);

// ─── Agents (custom agent factory) ─────────────────────
// Each row is one "configured agent" — its system prompt, allowed tools,
// branding, budget caps. Owners create them; visitors run them either
// using the owner's wallet (public) or their own (private/API-keyed).
export const agents = pgTable(
  'agents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    systemPrompt: text('system_prompt').notNull(),
    allowedTools: jsonb('allowed_tools').notNull(), // string[] of tool names
    primaryColor: text('primary_color').default('#7c5cff'),
    welcomeMessage: text('welcome_message'),
    quickPrompts: jsonb('quick_prompts'),           // string[]
    budgetPerSession: bigint('budget_per_session_micro', { mode: 'bigint' })
      .notNull()
      .default(500_000n),                            // $0.50 default soft cap
    hardCap: bigint('hard_cap_micro', { mode: 'bigint' })
      .notNull()
      .default(2_000_000n),                          // $2.00 default hard cap
    public: boolean('public').notNull().default(true),
    template: text('template'),                      // which template was the seed (optional)
    // 'visitor' = visitor needs their own API key, charges their wallet (default)
    // 'owner'   = visitor uses agent for free, owner's wallet pays for every call
    payMode: text('pay_mode').notNull().default('visitor'),
    // Daily budget cap when payMode=owner. Resets at UTC midnight.
    dailyBudgetMicro: bigint('daily_budget_micro', { mode: 'bigint' })
      .notNull()
      .default(5_000_000n),                          // $5.00 default
    // Minimum subscription tier the OWNER must hold to keep this agent live.
    // ('free' = anyone, 'pro' = Pro+, 'team' = Team+)
    tierRequired: text('tier_required').notNull().default('free'),
    // A/B testing — alternate system prompt + how often to send it (0-100).
    systemPromptB: text('system_prompt_b'),
    abSplit: integer('ab_split').notNull().default(0),  // % of traffic to variant B
    // Vanity domain mapping (e.g. "agent.cliente.com" → /agent/<slug>).
    // CNAME-only — actual cert/proxy handled by Cloudflare for SaaS or similar.
    vanityDomain: text('vanity_domain'),
    // Auto-detected language for UI strings ('auto' = use browser locale)
    uiLanguage: text('ui_language').notNull().default('auto'),
    // Owner's WhatsApp number (digits only, e.g. "5511995432538"). When an
    // inbound message comes from this number, the agent switches to
    // owner/personal-assistant mode (different persona, broader tool access).
    ownerPhone: text('owner_phone'),
    // Optional persona — when set, runtime prepends persona.prompt_fragment
    // to the system prompt and routes TTS through persona.voice_id_elevenlabs.
    // null = no persona (default Axon behavior).
    personaId: uuid('persona_id'),
    // Smart routing: when this agent receives the first turn from a contact,
    // it classifies the intent ('sales' / 'personal' / 'support') and forwards
    // every subsequent turn to the matching agent's prompt/tools/persona.
    // Shape: { sales?: uuid, personal?: uuid, support?: uuid }. null = leaf agent
    // (the routed-to one) or no routing configured.
    routesTo: jsonb('routes_to'),
    // Affiliate program (off-chain MVP). When enabled, anyone who brings a
    // new contact in via /agent/:slug?ref=<axon_user_id> earns
    // `affiliate_payout_micro` USDC the first time that contact engages.
    // The payout is a DB-level wallet transfer: debit owner, credit
    // affiliate, both in one transaction. No smart contract yet.
    affiliateEnabled: boolean('affiliate_enabled').notNull().default(false),
    affiliatePayoutMicro: bigint('affiliate_payout_micro', { mode: 'bigint' }).notNull().default(0n),
    // Owner-controlled global pause. When set, the WhatsApp webhook ignores
    // every inbound for this agent until the owner unpauses. Useful for
    // overnight quiet hours, manual debugging, or while testing changes
    // without losing the connection.
    pausedAt: timestamp('paused_at'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (t) => ({
    ownerIdx: index('agents_owner_idx').on(t.ownerId),
    slugIdx: uniqueIndex('agents_slug_idx').on(t.slug),
    vanityIdx: uniqueIndex('agents_vanity_idx').on(t.vanityDomain),
    ownerPhoneIdx: index('agents_owner_phone_idx').on(t.ownerPhone),
    personaIdx: index('agents_persona_idx').on(t.personaId),
  }),
);

// ─── Agent conversation log (opt-in privacy) ──────────────
// Records the user/assistant turn pairs from /v1/run/:slug/groq/chat
// so the owner can audit what visitors are asking. Tool results aren't
// persisted (they're noisy and may contain PII like CNPJ lookups).
export const agentMessages = pgTable(
  'agent_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    sessionId: text('session_id'),                   // anon hash of IP+UA, groups a conversation
    role: text('role').notNull(),                    // 'user' | 'assistant'
    content: text('content').notNull(),
    variant: text('variant'),                        // 'A' | 'B' for A/B testing
    visitorIp: text('visitor_ip'),                   // truncated /24 — kept for ratelimit forensics only
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => ({
    agentIdx: index('agent_msg_agent_idx').on(t.agentId),
    sessionIdx: index('agent_msg_session_idx').on(t.sessionId),
    createdIdx: index('agent_msg_created_idx').on(t.createdAt),
  }),
);

// ─── Agent Knowledge Cache (semantic dedup) ─────────────────
// Stores question/answer pairs for each agent. When a new query arrives,
// we compute its embedding and search this table for high-similarity
// (cosine >= 0.85) past entries. If found, return the cached answer
// instantly at ZERO cost. This is the biggest cost-reduction lever:
// for FAQ-heavy agents, cache hit rate hits 60-80% within a week.
//
// Embedding stored as jsonb (number[]). For >50k entries per agent we'd
// want pgvector + ivfflat index, but for v1 (<500 entries/agent) the
// app-layer cosine compute runs in <30ms.
export const agentCache = pgTable(
  'agent_cache',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    queryText: text('query_text').notNull(),
    queryEmbedding: jsonb('query_embedding').notNull(),  // number[] (1024 dims for voyage-2)
    responseText: text('response_text').notNull(),
    hits: integer('hits').notNull().default(0),
    lastHit: timestamp('last_hit').defaultNow().notNull(),
    costSavedMicro: bigint('cost_saved_micro', { mode: 'bigint' })
      .notNull()
      .default(0n),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => ({
    agentIdx: index('agent_cache_agent_idx').on(t.agentId),
    lastHitIdx: index('agent_cache_lasthit_idx').on(t.lastHit),
  }),
);

// Log of outbound deliveries (for retry/audit)
export const webhookDeliveries = pgTable(
  'webhook_deliveries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    subscriptionId: uuid('subscription_id')
      .notNull()
      .references(() => webhookSubscriptions.id, { onDelete: 'cascade' }),
    event: text('event').notNull(),
    payload: jsonb('payload').notNull(),
    attempts: integer('attempts').notNull().default(0),
    lastStatus: integer('last_status'),
    lastError: text('last_error'),
    deliveredAt: timestamp('delivered_at'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => ({
    subIdx: index('webhook_delivery_sub_idx').on(t.subscriptionId),
    createdIdx: index('webhook_delivery_created_idx').on(t.createdAt),
  }),
);

export type User = typeof users.$inferSelect;
export type Wallet = typeof wallets.$inferSelect;
export type Transaction = typeof transactions.$inferSelect;
export type ApiRegistryRow = typeof apiRegistry.$inferSelect;
export type RequestRow = typeof requests.$inferSelect;
export type PolicyRow = typeof policies.$inferSelect;
export type SettlementRow = typeof settlements.$inferSelect;
export type WebhookSubscription = typeof webhookSubscriptions.$inferSelect;
export type WebhookDelivery = typeof webhookDeliveries.$inferSelect;
export type Agent = typeof agents.$inferSelect;
export type AgentMessage = typeof agentMessages.$inferSelect;

// ─── WhatsApp connections (Evolution API integration) ────
// One row per agent ↔ Evolution-instance pairing. The agent owner
// brings their own Evolution server (self-hosted or managed) — Axon
// just registers a webhook on it and answers incoming messages.
export const whatsappConnections = pgTable(
  'whatsapp_connections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    instanceUrl: text('instance_url').notNull(),       // https://evo.example.com (no trailing slash)
    instanceName: text('instance_name').notNull(),      // identifier inside that Evolution server
    apiKey: text('api_key').notNull(),                  // ENCRYPTED at rest (see crypto.ts)
    webhookSecret: text('webhook_secret').notNull(),    // randomly generated, used in /v1/webhooks/whatsapp/:secret
    status: text('status').notNull().default('connected'), // 'connected' | 'disabled' | 'error'
    lastEventAt: timestamp('last_event_at'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (t) => ({
    agentIdx: index('wa_agent_idx').on(t.agentId),
    secretIdx: uniqueIndex('wa_secret_idx').on(t.webhookSecret),
  }),
);
export type WhatsappConnection = typeof whatsappConnections.$inferSelect;

// ─── Contact Memory (durable per-contact profile + facts) ────
// Keyed by (agent_id, phone). Stores long-term knowledge about each person
// the agent talks to: their name, language, preferences, plus an array of
// LLM-extracted facts ("alergic to lactose", "prefers PIX", etc).
//
// Loaded BEFORE every WhatsApp turn and injected into the system prompt so
// the agent recognizes the contact across sessions and personalizes responses.
// Owner can manually edit via /v1/agents/:id/contacts/:phone (PATCH).
export const contactMemory = pgTable(
  'contact_memory',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    phone: text('phone').notNull(),

    // Owner-editable profile
    displayName: text('display_name'),
    language: text('language').notNull().default('pt-br'),
    formality: text('formality').notNull().default('auto'),  // 'formal' | 'informal' | 'auto'
    tags: jsonb('tags').notNull().default(sql`'[]'::jsonb`),  // string[] e.g. ["VIP", "moroso"]

    // LLM-extracted durable facts. Shape: Array<{key, value, confidence, extracted_at}>
    facts: jsonb('facts').notNull().default(sql`'[]'::jsonb`),

    // Rolling summary (refreshed periodically when transcript exceeds N turns)
    summary: text('summary'),

    // Stats
    messageCount: integer('message_count').notNull().default(0),
    firstContactAt: timestamp('first_contact_at').defaultNow().notNull(),
    lastContactAt: timestamp('last_contact_at').defaultNow().notNull(),

    // Smart routing — once classified, this contact uses routedAgentId's
    // prompt/tools/persona for every subsequent turn. routeIntent is the
    // verdict that produced the routing (auditable). NULL on contacts that
    // never went through a router agent.
    routedAgentId: uuid('routed_agent_id'),
    routeIntent: text('route_intent'),

    // Affiliate attribution. Set on first contact creation when the
    // visitor arrived via /agent/:slug?ref=<axon_user_id>. The referenced
    // user gets paid `agents.affiliate_payout_micro` once `affiliate_paid_at`
    // flips from NULL to a timestamp (idempotent — never double-pay).
    referredByUserId: uuid('referred_by_user_id'),
    affiliatePaidAt: timestamp('affiliate_paid_at'),

    // Human handoff. Set when the WhatsApp owner replies manually from
    // their phone (we detect this via fromMe events that didn't originate
    // from our sendText). The webhook then mutes the agent for this
    // contact until the timestamp passes — gives the human time to handle
    // the conversation without the AI talking over them.
    humanPausedUntil: timestamp('human_paused_until'),

    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (t) => ({
    agentPhoneUnique: uniqueIndex('contact_memory_agent_phone_unique').on(t.agentId, t.phone),
    agentIdx: index('contact_memory_agent_idx').on(t.agentId),
    lastContactIdx: index('contact_memory_last_contact_idx').on(t.lastContactAt),
    routedAgentIdx: index('contact_memory_routed_agent_idx').on(t.routedAgentId),
    referredByIdx: index('contact_memory_referred_by_idx').on(t.referredByUserId),
  }),
);
export type ContactMemory = typeof contactMemory.$inferSelect;

// ─── Pix Payments (MercadoPago integration) ───────────────────
// Tracks pending → approved/expired/cancelled lifecycle of Pix charges.
// When status flips to 'approved', credit() in wallet/service.ts writes
// the immutable ledger row to `transactions` and updates the wallet
// balance. This table holds the short-lived QR + correlation state.
export const pixPayments = pgTable(
  'pix_payments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    mpPaymentId: text('mp_payment_id').notNull(),
    amountBrl: numeric('amount_brl', { precision: 12, scale: 2 }).notNull(),
    amountUsdcMicro: bigint('amount_usdc_micro', { mode: 'bigint' }),
    fxRateBrlPerUsd: numeric('fx_rate_brl_per_usd', { precision: 8, scale: 4 }),
    status: text('status').notNull().default('pending'),  // pending|approved|rejected|expired|cancelled
    qrCode: text('qr_code'),
    qrCodeBase64: text('qr_code_base64'),
    ticketUrl: text('ticket_url'),
    approvedAt: timestamp('approved_at'),
    expiresAt: timestamp('expires_at'),
    meta: jsonb('meta'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (t) => ({
    mpIdIdx: uniqueIndex('pix_mp_id_idx').on(t.mpPaymentId),
    userIdx: index('pix_user_idx').on(t.userId),
    statusIdx: index('pix_status_idx').on(t.status),
    createdIdx: index('pix_created_idx').on(t.createdAt),
  }),
);
export type PixPayment = typeof pixPayments.$inferSelect;

// ─── Personas (AI characters) ───────────────────────────────────
// Personas overlay on top of every agent: same tools, same business
// context, totally different *vibe*. Tia Zélia warm vs Don Salvatore
// dramatic vs Mestra Yobá zen — each a distinct voice for the same
// underlying capabilities. Owners pick one at agent creation; runtime
// prepends prompt_fragment to the system prompt and routes TTS through
// voice_id_elevenlabs.
export const personas = pgTable(
  'personas',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    tagline: text('tagline'),
    emoji: text('emoji'),
    toneDescription: text('tone_description').notNull(),
    promptFragment: text('prompt_fragment').notNull(),
    sampleGreeting: text('sample_greeting'),
    sampleSignoff: text('sample_signoff'),
    voiceIdElevenlabs: text('voice_id_elevenlabs'),
    avatarColorPrimary: text('avatar_color_primary').notNull().default('#7c5cff'),
    avatarColorSecondary: text('avatar_color_secondary').notNull().default('#19d5c6'),
    premium: boolean('premium').notNull().default(false),
    monthlyPriceBrl: integer('monthly_price_brl').notNull().default(0),
    active: boolean('active').notNull().default(true),
    displayOrder: integer('display_order').notNull().default(100),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (t) => ({
    slugIdx: uniqueIndex('personas_slug_idx').on(t.slug),
    activeIdx: index('personas_active_idx').on(t.active),
    orderIdx: index('personas_order_idx').on(t.displayOrder),
  }),
);
export type Persona = typeof personas.$inferSelect;
