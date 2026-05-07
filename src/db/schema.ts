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
  varchar,
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
    // Soft-delete: when set, the user is treated as deleted by every
    // authed query (apiKeyAuth refuses login). PII is wiped at delete
    // time but the row stays for FK integrity (transactions, requests,
    // settlements all point here, and we need them for accounting).
    deletedAt: timestamp('deleted_at'),
    // Previous api_key_hash kept valid for prevApiKeyExpiresAt window
    // so a user can rotate without an instant lockout. After expiry,
    // the old hash is null'd and only the current one works.
    prevApiKeyHash: text('prev_api_key_hash'),
    prevApiKeyExpiresAt: timestamp('prev_api_key_expires_at'),
    // API key in encrypted form (MASTER_ENCRYPTION_KEY). Distinct from
    // api_key_hash (which is a plain SHA-256 used for fast auth lookup).
    // We persist encrypted only for users who authenticated via a
    // verified channel (Supabase Auth, Privy) — this lets us return the
    // key on subsequent email logins instead of rotating every time.
    // NULL for legacy users created via /v1/signup before this column
    // existed; they still authenticate via the hash.
    apiKeyEncrypted: text('api_key_encrypted'),
    // Optional Supabase Auth user UUID linking the Axon user to the
    // Supabase auth.users row. Same email match also works (we use it
    // as a fallback) but the explicit link is durable across email
    // changes inside Supabase.
    supabaseUserId: uuid('supabase_user_id'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => ({
    apiKeyIdx: uniqueIndex('users_api_key_idx').on(t.apiKeyHash),
    emailIdx: uniqueIndex('users_email_idx').on(t.email),
    supabaseUserIdx: uniqueIndex('users_supabase_user_idx').on(t.supabaseUserId),
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
    // Free-text "important business info" the owner fills in: address,
    // hours, phone, prices, accepted insurances, specialties, anything
    // the agent should reference when answering customers. Injected into
    // the system_prompt at runtime so changes take effect immediately
    // without re-deploying the prompt.
    businessInfo: text('business_info'),
    // Catalog: structured inventory the agent uses as source of truth
    // for "what we have". Avoids the hallucination loop where the LLM
    // invents 3 properties to fill silence ("Casa em Apucirana R$950"
    // out of thin air). Owner uploads CSV/JSON via POST
    // /v1/agents/:id/catalog/upload — system parses + stores here.
    // Each item is a free-form record with a few "well-known" keys
    // (name, price, region, description, image_url) that the prompt
    // injection + search_catalog tool look for; everything else is
    // metadata available via the tool.
    catalog: jsonb('catalog'),
    /** When the catalog was last imported / refreshed. Surfaced in the
     *  /build dashboard ("atualizado há 3h") + Brain panel so the owner
     *  knows when to re-import. Updated on POST /catalog/upload and
     *  POST /catalog/import. NULL = never imported. */
    catalogImportedAt: timestamp('catalog_imported_at'),
    // Per-agent voice override + global voice toggle. When voiceEnabled
    // is false, the runtime never calls TTS regardless of persona/audio
    // mirroring. When voiceIdOverride is set, it wins over the persona's
    // default voice — useful when an owner picks a persona for the prompt
    // tone but wants a different voice (e.g. Tia Zélia prompt + a younger
    // ElevenLabs voice). null = use persona's default; null + no persona
    // = ElevenLabs DEFAULT_VOICE_ID.
    voiceEnabled: boolean('voice_enabled').notNull().default(true),
    voiceIdOverride: text('voice_id_override'),
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
    // Reasoning trace (assistant rows only): intent, routed_agent, tools_offered,
    // tool_calls, cache_hit, provider, latency_ms, cost_usdc, facts_used, eval{...}.
    // Drives the WhatsApp Brain "🧠 raciocínio" panel and the judge layer.
    meta: jsonb('meta'),
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
    /** Hash of (system rules + universal tool list) at write time. Cached
     *  responses with a stale rules_version are treated as misses so prompt
     *  / tool changes don't get masked by stale FAQ entries. */
    rulesVersion: varchar('rules_version', { length: 16 }),
  },
  (t) => ({
    agentIdx: index('agent_cache_agent_idx').on(t.agentId),
    lastHitIdx: index('agent_cache_lasthit_idx').on(t.lastHit),
    rulesVersionIdx: index('agent_cache_rules_version_idx').on(t.rulesVersion),
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

    // Conversation arc verdict — recomputed by judge.judgeArc() every N
    // turns. Shape: { state: 'progressing' | 'stuck' | 'frustrated' |
    // 'closing' | 'resolved', signals: string[], updated_at, turn_count_at_eval }
    // null = never evaluated yet (fewer than threshold turns).
    arc: jsonb('arc'),

    // Structured profile slots — canonical fields the LLM fills silently
    // across turns. Distinct from `facts` (free-form key/value): profile
    // has a fixed schema so the dashboard can render a proper "ficha do
    // cliente" with typed fields. Shape: ContactProfile (see contact-memory.ts).
    // Empty `{}` on first contact; LLM extracts new slots ONLY when empty
    // — manual owner edits are sticky and never overwritten by extraction.
    profile: jsonb('profile').notNull().default(sql`'{}'::jsonb`),

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

// ─── Contact Documents (silent CRM doc vault) ─────────────────
// Every PDF / photo a contact sends is uploaded to R2, classified by an
// LLM (exame/receita/comprovante/identidade/contrato/foto_pessoal/foto_produto/
// comprovante_endereco/outro), and indexed here. The dashboard surfaces this
// per-contact so the owner can see all docs that customer ever sent without
// scrolling the chat.
//
// extracted_text holds the raw text (PDF text via Gemini multimodal, image
// description via Vision) — same string that gets injected into the LLM
// system prompt context. Keeps a single source of truth.
//
// Storage: Cloudflare R2, key shape "documents/<agent_id>/<contact_id>/<id>.<ext>".
export const contactDocuments = pgTable(
  'contact_documents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    contactMemoryId: uuid('contact_memory_id')
      .notNull()
      .references(() => contactMemory.id, { onDelete: 'cascade' }),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),

    // File metadata
    filename: text('filename'),                       // best-effort, may be null
    mimeType: text('mime_type').notNull(),
    byteSize: integer('byte_size').notNull(),

    // R2 object key — full path inside the bucket
    storageKey: text('storage_key').notNull(),

    // 'inbound'  — customer sent this doc to the agent
    // 'outbound' — agent generated and sent this doc to the customer
    // Default 'inbound' so old rows (before 0025 migration) stay correct.
    direction: text('direction').notNull().default('inbound'),

    // LLM-classified taxonomy. Default 'outro' so unclassifiable docs still
    // get persisted and remain visible to the owner.
    docType: text('doc_type').notNull().default('outro'),

    // Raw extracted text (Vision description for images, Gemini multimodal
    // PDF text for documents). Same string injected into the LLM prompt.
    extractedText: text('extracted_text'),

    // One-line LLM-generated summary the dashboard shows in the list.
    summary: text('summary'),

    // Original caption / accompanying message text (rare for media but
    // possible — WhatsApp lets the user caption images and documents).
    callerCaption: text('caller_caption'),

    uploadedAt: timestamp('uploaded_at').defaultNow().notNull(),
  },
  (t) => ({
    contactIdx: index('contact_documents_contact_idx').on(t.contactMemoryId),
    agentIdx: index('contact_documents_agent_idx').on(t.agentId),
    docTypeIdx: index('contact_documents_doc_type_idx').on(t.docType),
    uploadedAtIdx: index('contact_documents_uploaded_at_idx').on(t.uploadedAt),
  }),
);
export type ContactDocument = typeof contactDocuments.$inferSelect;

// ─── Appointments + reminders ─────────────────────────────────
// One row per scheduled customer appointment. The agent inserts these
// via the `schedule_appointment` tool when it confirms a booking in
// chat. A daily cron job sweeps for `scheduled_for` ~24h ahead and
// fires a reminder via Evolution sendText, marking the reminder code
// (e.g. 'd-1') in `reminders_sent` so it never double-sends.
//
// Status lifecycle: confirmed → done (after the appointment passes,
// a future cron can flip it) | cancelled (customer cancels) | no_show.
export const appointments = pgTable(
  'appointments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    /** Soft-link to contact_memory; nullable so an appointment survives if
     *  the contact gets purged (LGPD soft-delete). The phone column below
     *  is the durable identifier. */
    contactMemoryId: uuid('contact_memory_id')
      .references(() => contactMemory.id, { onDelete: 'set null' }),
    /** Phone digits-only (e.g. "5511995432538") — the actual delivery target. */
    contactPhone: text('contact_phone').notNull(),
    /** Best-effort copy of the contact's display name at booking time. */
    contactName: text('contact_name'),

    /** Wall-clock timestamp of the appointment. timestamptz keeps timezone
     *  fidelity for cross-zone reads (the cron compares to UTC NOW()). */
    scheduledFor: timestamp('scheduled_for', { withTimezone: true }).notNull(),
    durationMinutes: integer('duration_minutes').default(30),
    description: text('description'),
    location: text('location'),

    /** 'confirmed' | 'pending' | 'cancelled' | 'done' | 'no_show'. Default
     *  confirmed since the agent only inserts after agreement in chat. */
    status: text('status').notNull().default('confirmed'),

    /** Reminder tags already fired. Shape: ['d-1', 'd-2h']. The cron
     *  appends here when it sends each reminder type, so re-runs are
     *  idempotent. */
    remindersSent: jsonb('reminders_sent').notNull().default(sql`'[]'::jsonb`),

    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (t) => ({
    agentIdx: index('appointments_agent_idx').on(t.agentId),
    contactIdx: index('appointments_contact_idx').on(t.contactMemoryId),
    scheduledIdx: index('appointments_scheduled_idx').on(t.scheduledFor),
    statusIdx: index('appointments_status_idx').on(t.status),
  }),
);
export type Appointment = typeof appointments.$inferSelect;

// ─── Agent subscriptions (per-agent monthly billing in USDC) ──
// One row per active agent. Plans: 'starter' ($40/mo) and 'pro' ($100/mo).
// Each plan ships with included monthly quotas (turns, vision describes,
// pdf generations, reminders); usage above the included tier is billed
// per-unit at overage rates and added to the next monthly debit.
//
// Lifecycle:
//   active   → normal operation, agent runs, counters tick
//   grace    → wallet didn't cover the renewal debit; 5-day window where
//              agent KEEPS RUNNING but owner sees a "deposite USDC" prompt.
//              After 5 days, cron flips status to 'cancelled' AND sets
//              agents.paused_at = NOW() so the WhatsApp webhook stops
//              dispatching to the LLM.
//   cancelled→ owner cancelled OR grace expired. Agent is paused, can be
//              reactivated by owner via /v1/agents/:id/subscription POST.
export const agentSubscriptions = pgTable(
  'agent_subscriptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    /** 'starter' | 'pro'. Defaults set in src/payment/plans.ts. */
    plan: text('plan').notNull().default('starter'),
    /** 'active' | 'grace' | 'cancelled'. */
    status: text('status').notNull().default('active'),

    /** Period boundaries for the current paid month. Cron compares
     *  current_period_end to NOW() to decide what to bill next. */
    currentPeriodStart: timestamp('current_period_start', { withTimezone: true })
      .notNull()
      .defaultNow(),
    currentPeriodEnd: timestamp('current_period_end', { withTimezone: true }).notNull(),

    /** Set when cron tries to bill but wallet is short. Drives the 5-day
     *  countdown (graceUntil = lastBillFailedAt + 5 days). */
    lastBillFailedAt: timestamp('last_bill_failed_at', { withTimezone: true }),
    graceUntil: timestamp('grace_until', { withTimezone: true }),

    /** Most recent successful debit. */
    lastBilledAt: timestamp('last_billed_at', { withTimezone: true }),
    /** Amount of last debit in USDC micro-units (6 decimals). */
    lastBillMicro: bigint('last_bill_micro', { mode: 'bigint' }).notNull().default(0n),

    /** Per-period usage counters — reset to 0 on successful billing.
     *  These drive the overage calculation. */
    usedTurns: integer('used_turns').notNull().default(0),
    usedVision: integer('used_vision').notNull().default(0),
    usedPdf: integer('used_pdf').notNull().default(0),
    usedReminders: integer('used_reminders').notNull().default(0),

    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (t) => ({
    agentUnique: uniqueIndex('agent_subscriptions_agent_idx').on(t.agentId),
    ownerIdx: index('agent_subscriptions_owner_idx').on(t.ownerId),
    statusIdx: index('agent_subscriptions_status_idx').on(t.status),
    periodEndIdx: index('agent_subscriptions_period_end_idx').on(t.currentPeriodEnd),
  }),
);
export type AgentSubscription = typeof agentSubscriptions.$inferSelect;

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

// ─── User voices (ElevenLabs IDs the user picked or cloned) ──────────────
// Each row = one voice the user can pick when configuring an agent.
//   - source='curated' → built-in voice we recommend (pre-seeded subset
//     of ElevenLabs library tagged for PT-BR / our personas)
//   - source='cloned'  → uploaded by the user via /v1/voices/clone, lives
//     in the user's ElevenLabs account (we just track the id+label here)
//   - source='persona' → mirror of a persona's voice_id_elevenlabs, used
//     so personas show in the picker without a special-case query
// `external_id` is the ElevenLabs voice_id (always 8-32 alphanumeric).
// `label` is what the picker displays. `preview_url` is an optional
// pre-rendered MP3 url (S3/CDN/blob); when null the picker generates
// the preview on demand and caches it via /v1/voices/:id/preview.mp3.
export const userVoices = pgTable(
  'user_voices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    externalId: text('external_id').notNull(),
    label: text('label').notNull(),
    source: text('source').notNull().default('cloned'),
    previewUrl: text('preview_url'),
    meta: jsonb('meta'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => ({
    userIdx: index('user_voices_user_idx').on(t.userId),
    extIdx: uniqueIndex('user_voices_user_ext_idx').on(t.userId, t.externalId),
  }),
);
export type UserVoice = typeof userVoices.$inferSelect;

// ─── Admin audit log ─────────────────────────────────────────────────
// Append-only record of every privileged action: admin creates a user,
// credits a wallet, changes a policy, marks a settlement paid, runs
// /reset-signup-limit, etc. Plus user-side privileged actions: API
// key rotation, account deletion, 2FA setup. We keep ONE table for
// both kinds because the question "who did this and when" is the same
// either way.
//
// `actor_user_id` is null when the action is gated only by ADMIN_API_KEY
// (no user context). `target_user_id` is the affected user when one
// makes sense (credit, policy, etc); otherwise null. `meta` captures
// the request body / parameters / before-and-after deltas; small enough
// for jsonb, big enough to reconstruct the action.
//
// Append-only by convention — there's no UPDATE or DELETE in any code
// path. Operators can query directly for compliance asks.
export const adminAuditLog = pgTable(
  'admin_audit_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    actorUserId: uuid('actor_user_id'),
    actorAdminKey: boolean('actor_admin_key').notNull().default(false),
    targetUserId: uuid('target_user_id'),
    action: text('action').notNull(),
    requestId: text('request_id'),
    ip: text('ip'),
    userAgent: text('user_agent'),
    meta: jsonb('meta'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => ({
    actorIdx: index('audit_actor_idx').on(t.actorUserId),
    targetIdx: index('audit_target_idx').on(t.targetUserId),
    actionIdx: index('audit_action_idx').on(t.action),
    createdIdx: index('audit_created_idx').on(t.createdAt),
  }),
);
export type AuditLogRow = typeof adminAuditLog.$inferSelect;

// ─── User MFA (TOTP per RFC 6238) ────────────────────────────────────
// One row per user that has 2FA enabled. Secret stored encrypted via
// MASTER_ENCRYPTION_KEY (same envelope as wallet seed). Verified-at
// is set the first time the user proves they have the device — until
// then, login still works without 2FA so a half-finished setup doesn't
// brick the account.
export const userMfa = pgTable('user_mfa', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  // AES-GCM ciphertext of the base32-decoded TOTP secret (20 bytes).
  secretCipher: text('secret_cipher').notNull(),
  verifiedAt: timestamp('verified_at'),
  // Last-used counter — protects against immediate replay of the same
  // 6-digit code within the 30-second window.
  lastCounter: bigint('last_counter', { mode: 'bigint' }),
  // Recovery codes (also encrypted as a single JSON blob). Each code
  // is consumed on use; we don't track individual rows because the
  // set is small (8-10) and rotation is rare.
  recoveryCipher: text('recovery_cipher'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});
export type UserMfa = typeof userMfa.$inferSelect;
