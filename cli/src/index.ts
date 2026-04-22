#!/usr/bin/env node
/**
 * Axon CLI — operator toolkit.
 *
 *   axon user:create [--email=you@you.dev]
 *   axon balance --user=<uuid> | --key=ax_live_...
 *   axon topup --user=<uuid> --amount=25 [--tx=0x...]
 *   axon policy:get --user=<uuid>
 *   axon policy:set --user=<uuid> --daily=10 --deny=replicate
 *   axon usage [--key=ax_live_...]
 *   axon stats
 *   axon settle
 *   axon catalog
 *
 * Env:
 *   AXON_URL          your gateway URL (default: http://localhost:3000)
 *   AXON_ADMIN_KEY    required for admin commands
 *   AXON_KEY          required for user-facing commands (balance, usage)
 */
import { Axon } from '@axon/client';
import { parseArgs, print, printError, fmtJSON, confirm } from './util.js';

const COMMANDS = {
  'user:create': userCreate,
  balance,
  topup,
  'policy:get': policyGet,
  'policy:set': policySet,
  'policy:delete': policyDelete,
  usage,
  stats,
  settle,
  catalog,
  help: printHelp,
  '--help': printHelp,
  '-h': printHelp,
};

async function main() {
  const [cmd = 'help', ...rest] = process.argv.slice(2);
  const fn = COMMANDS[cmd as keyof typeof COMMANDS];
  if (!fn) {
    printError(`Unknown command: ${cmd}`);
    printHelp();
    process.exit(1);
  }
  try {
    await fn(parseArgs(rest));
  } catch (err: any) {
    printError(err?.message ?? String(err));
    process.exit(1);
  }
}

// ─── helpers ────────────────────────────────────────────
function base(): string {
  return process.env.AXON_URL ?? 'http://localhost:3000';
}

function adminKey(): string {
  const k = process.env.AXON_ADMIN_KEY;
  if (!k) throw new Error('AXON_ADMIN_KEY env var is required for this command.');
  return k;
}

function userClient(): Axon {
  const k = process.env.AXON_KEY;
  if (!k) throw new Error('AXON_KEY env var is required for this command.');
  return new Axon({ apiKey: k, baseUrl: base() });
}

async function adminFetch(
  path: string,
  init: RequestInit = {},
): Promise<unknown> {
  const headers: Record<string, string> = {
    'x-admin-key': adminKey(),
    ...(init.body ? { 'content-type': 'application/json' } : {}),
  };
  const res = await fetch(base() + path, { ...init, headers });
  const text = await res.text();
  const body = text ? (safeJSON(text) ?? text) : null;
  if (!res.ok) {
    throw new Error(
      typeof body === 'object' && body && 'message' in (body as any)
        ? String((body as any).message)
        : `HTTP ${res.status}: ${text}`,
    );
  }
  return body;
}

function safeJSON(s: string): unknown {
  try { return JSON.parse(s); } catch { return null; }
}

// ─── commands ───────────────────────────────────────────

async function userCreate(args: Record<string, string | boolean>) {
  const email = (args.email as string) || undefined;
  const body = email ? JSON.stringify({ email }) : JSON.stringify({});
  const res = await adminFetch('/v1/admin/users', { method: 'POST', body });
  print(fmtJSON(res));
  print('');
  print('Save the api_key now — it cannot be retrieved later.');
}

async function balance(args: Record<string, string | boolean>) {
  const key = (args.key as string) ?? process.env.AXON_KEY;
  if (!key) throw new Error('Provide --key=ax_live_... or AXON_KEY env var.');
  const client = new Axon({ apiKey: key, baseUrl: base() });
  const b = await client.wallet.balance();
  print(fmtJSON(b));
}

async function topup(args: Record<string, string | boolean>) {
  const user = args.user as string;
  const amount = args.amount as string;
  const tx = args.tx as string | undefined;
  if (!user || !amount) throw new Error('Required: --user=<uuid> --amount=<usdc>');
  const body = JSON.stringify({ user_id: user, amount_usdc: amount, onchain_tx: tx });
  const res = await adminFetch('/v1/admin/credit', { method: 'POST', body });
  print(fmtJSON(res));
}

async function policyGet(args: Record<string, string | boolean>) {
  const user = args.user as string;
  if (!user) throw new Error('Required: --user=<uuid>');
  const res = await adminFetch(`/v1/admin/policy/${user}`);
  print(fmtJSON(res));
}

async function policySet(args: Record<string, string | boolean>) {
  const user = args.user as string;
  if (!user) throw new Error('Required: --user=<uuid>');
  const rules: Record<string, unknown> = {};
  if (args.daily)   rules.daily_budget_micro    = usdcToMicro(String(args.daily));
  if (args.monthly) rules.monthly_budget_micro  = usdcToMicro(String(args.monthly));
  if (args.maxcall) rules.max_request_cost_micro = usdcToMicro(String(args.maxcall));
  if (args.allow)   rules.allow_apis = String(args.allow).split(',').map((s) => s.trim());
  if (args.deny)    rules.deny_apis  = String(args.deny).split(',').map((s) => s.trim());
  if (args['exclude-cache']) rules.exclude_cache_from_budget = true;
  if (args.label)   rules.label = String(args.label);

  const res = await adminFetch(`/v1/admin/policy/${user}`, {
    method: 'PUT',
    body: JSON.stringify(rules),
  });
  print(fmtJSON(res));
}

async function policyDelete(args: Record<string, string | boolean>) {
  const user = args.user as string;
  if (!user) throw new Error('Required: --user=<uuid>');
  if (!(await confirm(`Delete policy for ${user}?`))) return;
  const res = await adminFetch(`/v1/admin/policy/${user}`, { method: 'DELETE' });
  print(fmtJSON(res));
}

async function usage(_args: Record<string, string | boolean>) {
  const client = userClient();
  const summary = await client.usage.summary();
  const byApi = await client.usage.byApi();
  print('Summary:');
  print(fmtJSON(summary));
  print('');
  print('By API:');
  print(fmtJSON(byApi));
}

async function stats(_args: Record<string, string | boolean>) {
  const res = await fetch(`${base()}/v1/stats/public?days=30`);
  print(fmtJSON(await res.json()));
}

async function settle(_args: Record<string, string | boolean>) {
  const res = await adminFetch('/v1/admin/settlements/run', {
    method: 'POST',
    body: JSON.stringify({}),
  });
  print(fmtJSON(res));
}

async function catalog(_args: Record<string, string | boolean>) {
  const res = await fetch(`${base()}/v1/apis`);
  const body = await res.json() as any;
  for (const api of body.data) {
    print(`${api.slug.padEnd(18)} ${api.provider.padEnd(20)} ${api.category.padEnd(18)} endpoints: ${api.endpoints.join(', ')}`);
  }
  print('');
  print(`${body.count} APIs total.`);
}

function usdcToMicro(usdc: string): string {
  const [i, f = ''] = usdc.split('.');
  const frac = (f + '000000').slice(0, 6);
  return String(BigInt(i) * 1_000_000n + BigInt(frac || '0'));
}

function printHelp() {
  print(`Axon CLI

USAGE
  axon <command> [--flag=value]

COMMANDS
  user:create [--email=x]           Create a user, print api_key + deposit_address
  balance [--key=ax_live_...]        Show wallet balance (uses AXON_KEY env if no flag)
  topup --user=<uuid> --amount=<usdc> [--tx=0x...]
                                     Credit a user's wallet (admin)
  policy:get --user=<uuid>           Show user's policy
  policy:set --user=<uuid> [...]     Upsert user's policy
      --daily=<usdc>                 daily budget cap
      --monthly=<usdc>               monthly budget cap
      --maxcall=<usdc>               max per-request cost
      --allow=a,b,c                  allowlist (comma-separated slugs)
      --deny=a,b                     denylist
      --exclude-cache                don't count cache hits against budget
      --label="name"                 human-readable label
  policy:delete --user=<uuid>        Remove policy (interactive confirm)
  usage [--key=ax_live_...]          Your usage summary + by-API breakdown
  stats                              Public anonymized stats
  settle                             Trigger a settlement run now
  catalog                            List available APIs

ENVIRONMENT
  AXON_URL           gateway URL (default: http://localhost:3000)
  AXON_ADMIN_KEY     required for admin commands
  AXON_KEY           required for user commands

EXAMPLES
  axon user:create --email=alice@acme.dev
  axon balance --key=ax_live_abc123...
  axon topup --user=xxx --amount=25
  axon policy:set --user=xxx --daily=10 --deny=replicate,stability
  axon stats
`);
}

main();
