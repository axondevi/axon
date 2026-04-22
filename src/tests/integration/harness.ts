/**
 * Integration test harness for Axon.
 *
 * These tests exercise the real Hono app via its `fetch` handler — no HTTP
 * server needed. DB and Redis are optional; when absent, we stub the modules
 * to keep tests hermetic.
 *
 * Run:  bun test src/tests/integration
 *
 * NOTE: Integration tests import the full app (pulls in db, redis). If you
 * don't want that weight in the main `bun test` run, they're scoped to the
 * `integration/` folder.
 */

// Minimum env so config.ts doesn't process.exit(1) at import time.
process.env.NODE_ENV ??= 'test';
process.env.MASTER_ENCRYPTION_KEY ??=
  'test_master_key_hex_must_be_at_least_32_chars_long_abc';
process.env.ADMIN_API_KEY ??=
  'test_admin_key_hex_must_be_at_least_32_chars_long_abc';
process.env.DATABASE_URL ??= 'postgres://test@localhost/test';
process.env.REDIS_URL ??= 'redis://localhost:6379';

import { mock } from 'bun:test';

// ─── Stub the db module before any test imports it ────────
const txRows: any[] = [];
const reqRows: any[] = [];
const walletByUser: Record<string, any> = {};
const usersByHash: Record<string, any> = {};

const fakeDb = {
  insert: (_table: any) => ({
    values: (rows: any) => ({
      returning: async () => {
        const arr = Array.isArray(rows) ? rows : [rows];
        for (const r of arr) {
          const row = { id: r.id ?? crypto.randomUUID(), ...r };
          if (_table.name === 'users') usersByHash[row.apiKeyHash] = row;
          if (_table.name === 'wallets') walletByUser[row.userId] = row;
          if (_table.name === 'transactions') txRows.push(row);
          if (_table.name === 'requests') reqRows.push(row);
        }
        return arr.map((r: any) => ({ id: r.id ?? crypto.randomUUID(), ...r }));
      },
      onConflictDoNothing: async () => [],
      onConflictDoUpdate: async () => [],
    }),
  }),
  select: () => ({
    from: () => ({
      where: () => ({
        limit: async () => [],
        orderBy: () => ({ limit: async () => [] }),
      }),
      orderBy: () => ({ limit: async () => [] }),
      groupBy: () => ({
        orderBy: async () => [],
      }),
    }),
  }),
  update: () => ({
    set: () => ({
      where: () => ({
        returning: async () => [{ balanceMicro: 0n }],
      }),
    }),
  }),
  delete: () => ({ where: async () => [] }),
  execute: async () => [],
};

mock.module('~/db', () => ({ db: fakeDb, schema: {} }));

// ─── Stub redis ───────────────────────────────────────────
const fakeRedis = {
  get: async () => null,
  setex: async () => 'OK',
  ping: async () => 'PONG',
  multi: () => ({
    incr: () => fakeRedis,
    expire: () => fakeRedis,
    exec: async () => [
      [null, 1],
      [null, 1],
    ],
  }),
  quit: async () => 'OK',
  on: () => {},
};

mock.module('~/cache/redis', () => ({ redis: fakeRedis }));

// ─── Import the real app ─────────────────────────────────
export async function importApp() {
  const mod = await import('~/index');
  return mod.default as { fetch: (req: Request) => Promise<Response> };
}

export const testFixtures = { txRows, reqRows, walletByUser, usersByHash };
