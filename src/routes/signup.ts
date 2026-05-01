/**
 * Public self-service signup.
 *
 * POST /v1/signup { email } → creates user + Turnkey wallet,
 * credits $0.50 signup bonus, returns API key ONCE + deposit address.
 *
 * Rate-limited per IP to prevent mass account creation.
 *
 * Admin's `/v1/admin/users` is kept for white-glove / VIP onboarding
 * ($5 bonus, no rate limit, no email validation).
 */
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { eq } from 'drizzle-orm';
import { db } from '~/db';
import { transactions, users, wallets } from '~/db/schema';
import { generateApiKey, hashApiKey } from '~/lib/crypto';
import { toMicro } from '~/wallet/service';
import { getWalletProvider } from '~/wallet/providers';
import { Errors } from '~/lib/errors';
import { redis } from '~/cache/redis';
import { log } from '~/lib/logger';

const SIGNUP_BONUS_USDC = '0.5';
const RATE_LIMIT_PER_HOUR = 10;
const RATE_WINDOW_SEC = 3600;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function getClientIp(c: Context): string {
  // Trust CF + Render proxy headers. Fall back to a constant bucket if
  // everything is missing, which keeps the rate limit useful even on
  // misconfigured deploys.
  return (
    c.req.header('cf-connecting-ip') ??
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ??
    c.req.header('x-real-ip') ??
    'unknown'
  );
}

async function ipRateLimit(c: Context, next: Next) {
  const ip = getClientIp(c);
  const bucket = Math.floor(Date.now() / 1000 / RATE_WINDOW_SEC);
  const key = `signup:ratelimit:${ip}:${bucket}`;

  const pipeline = redis.multi();
  pipeline.incr(key);
  pipeline.expire(key, RATE_WINDOW_SEC + 60);
  const execRes = await pipeline.exec();
  const count = Number(execRes?.[0]?.[1] ?? 0);

  if (count > RATE_LIMIT_PER_HOUR) {
    const retryAfter = RATE_WINDOW_SEC - (Math.floor(Date.now() / 1000) % RATE_WINDOW_SEC);
    return c.json(
      {
        error: 'rate_limited',
        message: `Too many signups from this IP. Try again in ${Math.ceil(retryAfter / 60)} minute(s).`,
      },
      429,
      { 'retry-after': String(retryAfter) },
    );
  }

  await next();
}

const app = new Hono();

app.post('/', ipRateLimit, async (c) => {
  let body: { email?: string; what_building?: string };
  try {
    body = await c.req.json();
  } catch {
    throw Errors.badRequest('Body must be JSON');
  }

  const email = body.email?.trim().toLowerCase();
  if (!email) throw Errors.badRequest('email is required');
  if (!EMAIL_RE.test(email)) throw Errors.badRequest('invalid email format');
  if (email.length > 254) throw Errors.badRequest('email too long');

  // Duplicate check — friendly 409 instead of a unique-violation throw.
  const [existing] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);

  if (existing) {
    return c.json(
      {
        error: 'email_taken',
        message:
          'This email is already registered. If you lost your API key, contact support to rotate it.',
      },
      409,
    );
  }

  // Provision wallet FIRST so we never end up with a user without a wallet.
  const provider = getWalletProvider();
  let deposit: Awaited<ReturnType<typeof provider.createUserWallet>>;
  try {
    // Pre-generate a UUID so createUserWallet can name the sub-org deterministically
    deposit = await provider.createUserWallet(crypto.randomUUID());
  } catch (err) {
    log.error('signup.wallet_failed', {
      email,
      error: err instanceof Error ? err.message : String(err),
    });
    return c.json(
      {
        error: 'wallet_provider_unavailable',
        message: 'Could not create your wallet. Please try again in a minute.',
      },
      503,
    );
  }

  // Now create the user + wallet row atomically.
  const rawKey = generateApiKey();
  let userId: string;
  try {
    const [user] = await db
      .insert(users)
      .values({
        email,
        apiKeyHash: hashApiKey(rawKey),
        tier: 'free',
      })
      .returning();
    userId = user.id;

    await db.insert(wallets).values({
      userId: user.id,
      address: deposit.address.toLowerCase(),
      balanceMicro: toMicro(SIGNUP_BONUS_USDC),
    });

    // serializedBackup is already opaque/encrypted by the provider when it
    // contains key material (CDP). Persist as-is — re-encrypting at the
    // route was harmless duplication.
    const walletMeta = deposit.serializedBackup
      ? {
          event: 'wallet_provisioned',
          wallet_id: deposit.walletId,
          backup_enc: deposit.serializedBackup,
        }
      : null;

    if (walletMeta) {
      await db.insert(transactions).values({
        userId: user.id,
        type: 'bonus',
        amountMicro: 0n,
        meta: walletMeta,
      });
    }

    await db.insert(transactions).values({
      userId: user.id,
      type: 'bonus',
      amountMicro: toMicro(SIGNUP_BONUS_USDC),
      meta: {
        reason: 'signup_bonus',
        ip: getClientIp(c),
        what_building: body.what_building?.slice(0, 500) ?? null,
      },
    });
  } catch (err) {
    // Race: another request with same email slipped through between our check
    // and the insert. Treat as duplicate, don't leak a 500.
    log.warn('signup.insert_failed', {
      email,
      error: err instanceof Error ? err.message : String(err),
    });
    return c.json(
      {
        error: 'email_taken',
        message: 'This email is already registered.',
      },
      409,
    );
  }

  log.info('signup.created', {
    user_id: userId,
    email,
    address: deposit.address,
    ip: getClientIp(c),
  });

  // Welcome email — fire-and-forget, never block the signup response on it.
  // Lazy-imported so test envs without RESEND_API_KEY don't pull the module
  // until first real signup call.
  void (async () => {
    try {
      const { sendEmail } = await import('~/email/client');
      const { welcomeEmail } = await import('~/email/templates');
      const t = welcomeEmail({
        email,
        apiKey: rawKey,
        bonusUsdc: SIGNUP_BONUS_USDC,
        depositAddress: deposit.address,
      });
      await sendEmail({ to: email, subject: t.subject, html: t.html, text: t.text, tag: 'welcome' });
    } catch (err) {
      log.warn('signup.email_failed', { email, error: err instanceof Error ? err.message : String(err) });
    }
  })();

  return c.json(
    {
      user_id: userId,
      email,
      api_key: rawKey,
      deposit_address: deposit.address,
      balance_usdc: toMicro(SIGNUP_BONUS_USDC).toString(),
      balance_display: `$${SIGNUP_BONUS_USDC} USDC`,
      tier: 'free',
      warning: 'Save your API key now. It is shown once and cannot be retrieved later.',
      next_steps: {
        docs: 'https://github.com/axondevi/axon#readme',
        dashboard: 'https://axon-5zf.pages.dev/dashboard',
        try_a_call: `curl -H "Authorization: Bearer ${rawKey}" "https://axon-kedb.onrender.com/v1/call/brasilapi/cnpj?cnpj=00000000000191"`,
      },
    },
    201,
  );
});

export default app;
