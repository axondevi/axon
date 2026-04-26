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
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => ({
    userIdx: index('req_user_idx').on(t.userId),
    apiIdx: index('req_api_idx').on(t.apiSlug),
    createdIdx: index('req_created_idx').on(t.createdAt),
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
