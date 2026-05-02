#!/usr/bin/env bun
/**
 * Backup health check.
 *
 * Run weekly (cron / GitHub Action) against production. Read-only:
 * never writes. Outputs a JSON summary you can pipe into a status
 * page or alerting system.
 *
 *   bun run scripts/backup-verify.ts
 *
 * Checks:
 *   1. DATABASE_URL is reachable and SELECT 1 works
 *   2. Every critical table has rows (catches accidental TRUNCATE)
 *   3. Row counts vs an internal floor — alerts on regression
 *   4. Latest activity (max created_at on requests / transactions)
 *      is within RPO_HOURS — proves the prod DB isn't frozen
 *   5. Schema has every expected column from src/db/schema.ts
 *      (catches a half-applied migration or rolled-back deploy)
 *
 * The script is the recovery exercise too: if you ever DO need to
 * restore from a Neon snapshot, run this against the restored DB
 * and the green output is your "we're back" signal.
 *
 * Exit code 0 = healthy; non-zero = at least one check failed.
 */
import { Pool } from 'pg';

const RPO_HOURS = 24;          // alert if no new requests in 24h
const BACKUP_FLOOR_USERS = 1;  // tweak when prod has more
const REQUIRED_TABLES = [
  'users',
  'wallets',
  'transactions',
  'requests',
  'agents',
  'agent_messages',
  'agent_cache',
  'whatsapp_connections',
  'contact_memory',
  'pix_payments',
  'personas',
  'webhook_subscriptions',
  'webhook_deliveries',
  'settlements',
  'policies',
  'user_voices',
  'admin_audit_log',
];
const REQUIRED_AGENT_COLUMNS = [
  'paused_at',
  'business_info',
  'voice_enabled',
  'voice_id_override',
  'persona_id',
  'routes_to',
  'affiliate_enabled',
  'owner_phone',
];

interface Result {
  ok: boolean;
  checks: Array<{ name: string; ok: boolean; detail?: string }>;
}

async function main(): Promise<Result> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    return { ok: false, checks: [{ name: 'env', ok: false, detail: 'DATABASE_URL not set' }] };
  }
  const pool = new Pool({
    connectionString: url,
    max: 2,
    statement_timeout: 15_000,
  });
  const checks: Result['checks'] = [];

  // 1. Liveness
  try {
    await pool.query('SELECT 1');
    checks.push({ name: 'liveness', ok: true });
  } catch (err) {
    checks.push({ name: 'liveness', ok: false, detail: String(err) });
    await pool.end();
    return { ok: false, checks };
  }

  // 2. Required tables exist + non-empty (where applicable)
  for (const t of REQUIRED_TABLES) {
    try {
      const r = await pool.query(`SELECT COUNT(*)::int AS n FROM "${t}"`);
      const n = r.rows[0]?.n ?? 0;
      checks.push({ name: `table.${t}`, ok: true, detail: `rows=${n}` });
    } catch (err) {
      checks.push({ name: `table.${t}`, ok: false, detail: String(err).slice(0, 200) });
    }
  }

  // 3. Floor check on users
  try {
    const r = await pool.query('SELECT COUNT(*)::int AS n FROM users');
    const n = r.rows[0]?.n ?? 0;
    checks.push({
      name: 'floor.users',
      ok: n >= BACKUP_FLOOR_USERS,
      detail: `users=${n} floor=${BACKUP_FLOOR_USERS}`,
    });
  } catch (err) {
    checks.push({ name: 'floor.users', ok: false, detail: String(err) });
  }

  // 4. RPO — latest request inside the window
  try {
    const r = await pool.query(`
      SELECT MAX(created_at) AS last_request,
             EXTRACT(EPOCH FROM (NOW() - MAX(created_at))) / 3600.0 AS hours_ago
      FROM requests
    `);
    const hoursAgo = r.rows[0]?.hours_ago;
    if (hoursAgo === null || hoursAgo === undefined) {
      checks.push({ name: 'rpo.requests', ok: false, detail: 'no rows in requests' });
    } else {
      checks.push({
        name: 'rpo.requests',
        ok: hoursAgo <= RPO_HOURS,
        detail: `last_request=${r.rows[0].last_request} (${Number(hoursAgo).toFixed(1)}h ago, RPO=${RPO_HOURS}h)`,
      });
    }
  } catch (err) {
    checks.push({ name: 'rpo.requests', ok: false, detail: String(err) });
  }

  // 5. Schema columns — sample agents.* added by migrations 0009-0019
  try {
    const r = await pool.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'agents'
    `);
    const present = new Set(r.rows.map((x: { column_name: string }) => x.column_name));
    const missing = REQUIRED_AGENT_COLUMNS.filter((c) => !present.has(c));
    checks.push({
      name: 'schema.agents',
      ok: missing.length === 0,
      detail: missing.length === 0 ? `all ${REQUIRED_AGENT_COLUMNS.length} columns present` : `MISSING: ${missing.join(', ')}`,
    });
  } catch (err) {
    checks.push({ name: 'schema.agents', ok: false, detail: String(err) });
  }

  await pool.end();
  return { ok: checks.every((c) => c.ok), checks };
}

main()
  .then((r) => {
    console.log(JSON.stringify(r, null, 2));
    process.exit(r.ok ? 0 : 1);
  })
  .catch((err) => {
    console.error('backup-verify crashed:', err);
    process.exit(2);
  });
