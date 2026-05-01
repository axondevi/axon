/**
 * Tiny structured logger. JSON in production, human-readable in dev.
 *
 *   log.info('upstream call', { slug: 'serpapi', cost: '0.005' });
 *
 * Output (prod): {"level":"info","msg":"upstream call","slug":"serpapi","cost":"0.005","ts":"…"}
 * Output (dev):  INFO   upstream call          slug=serpapi cost=0.005
 *
 * Production picks itself via NODE_ENV=production. Override via LOG_FORMAT.
 */

type Level = 'debug' | 'info' | 'warn' | 'error';
const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const FORMAT = (process.env.LOG_FORMAT ||
  (process.env.NODE_ENV === 'production' ? 'json' : 'pretty')) as
  | 'json'
  | 'pretty';

const MIN: Level = (process.env.LOG_LEVEL as Level) || 'info';

function emit(level: Level, msg: string, fields?: Record<string, unknown>) {
  if (LEVELS[level] < LEVELS[MIN]) return;
  const payload: Record<string, unknown> = {
    level,
    msg,
    ts: new Date().toISOString(),
    ...fields,
  };
  if (FORMAT === 'json') {
    process.stdout.write(JSON.stringify(payload, bigintReplacer) + '\n');
    return;
  }
  // Pretty format — tty-friendly, grep-able
  const color =
    level === 'error' ? '\x1b[31m' : level === 'warn' ? '\x1b[33m' : level === 'debug' ? '\x1b[90m' : '\x1b[36m';
  const reset = '\x1b[0m';
  const head = `${color}${level.toUpperCase().padEnd(5)}${reset}`;
  let tail = '';
  if (fields) {
    for (const [k, v] of Object.entries(fields)) {
      tail += ` ${k}=${formatValue(v)}`;
    }
  }
  process.stdout.write(`${head}  ${msg}${tail}\n`);
}

function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}

function formatValue(v: unknown): string {
  if (v === null || v === undefined) return String(v);
  if (typeof v === 'string') return /\s/.test(v) ? JSON.stringify(v) : v;
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'object') return JSON.stringify(v, bigintReplacer);
  return String(v);
}

export const log = {
  debug: (msg: string, fields?: Record<string, unknown>) => emit('debug', msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) => emit('info', msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => emit('warn', msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => emit('error', msg, fields),
};

/**
 * PII redaction helpers. Use when emitting log fields that may contain
 * customer-controlled phone numbers / emails / addresses (LGPD says you
 * can keep them, but only with the bare minimum needed to operate).
 *
 *   redactPhone('5511995432538') → '5511***2538'
 *   redactEmail('kaolin@gmail.com') → 'k***@gmail.com'
 *
 * The mid is fully obscured so the logged value is enough to correlate
 * a single user across requests but not to identify them outside the
 * platform.
 */
export function redactPhone(phone: string | null | undefined): string {
  if (!phone) return '';
  const digits = String(phone).replace(/\D/g, '');
  if (digits.length < 6) return '***';
  return `${digits.slice(0, 4)}***${digits.slice(-4)}`;
}

export function redactEmail(email: string | null | undefined): string {
  if (!email) return '';
  const at = String(email).indexOf('@');
  if (at < 1) return '***';
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const head = local.slice(0, 1);
  return `${head}${'*'.repeat(Math.max(2, local.length - 1))}@${domain}`;
}
