/**
 * Supabase Auth login — verified email login → Axon API key.
 *
 * Flow:
 *   1. Frontend: supabase.auth.signInWithPassword (or magic link, OAuth)
 *      → returns a Supabase session with access_token (JWT, ~1h ttl).
 *   2. Frontend POSTs the access_token here.
 *   3. We verify by calling Supabase's `/auth/v1/user` endpoint with the
 *      token (Supabase validates signature + expiry server-side; saves us
 *      from importing the JWT_SECRET). On success we get { id, email }.
 *   4. Look up the Axon user by:
 *        a) supabase_user_id match (set on previous login)
 *        b) email match (covers the very first Supabase login of an
 *           existing /v1/signup-only account)
 *   5. If found: return the persisted API key (decrypted from
 *      api_key_encrypted). If api_key_encrypted is NULL (legacy),
 *      rotate to a new key, store hash + encrypted, return the new one
 *      with a 5-min grace window on the old hash.
 *   6. If not found: create user + Turnkey wallet (signup-bonus path),
 *      persist both hash and encrypted forms, return the key once.
 *
 * Required envs:
 *   SUPABASE_PROJECT_URL    — e.g. https://bntmsqwrzlozagvemjys.supabase.co
 *   SUPABASE_ANON_KEY       — public anon JWT (sent as `apikey` header)
 *   MASTER_ENCRYPTION_KEY   — already used elsewhere, encrypts api_key
 *
 * Public companion endpoint: GET /v1/auth/supabase/config
 *   Returns { project_url, anon_key, configured } so the frontend can
 *   bootstrap its supabase-js client without hard-coding values.
 */
import { Hono } from 'hono';
import { eq, sql } from 'drizzle-orm';
import { db } from '~/db';
import { users, wallets, transactions } from '~/db/schema';
import { generateApiKey, hashApiKey, encrypt, decrypt } from '~/lib/crypto';
import { log } from '~/lib/logger';
import { toMicro } from '~/wallet/service';
import { getWalletProvider } from '~/wallet/providers';
import { randomUUID } from 'node:crypto';

const app = new Hono();

const SIGNUP_BONUS_USDC = 0.5;
const ROTATION_GRACE_MS = 5 * 60 * 1000; // 5 minutes

interface SupabaseUser {
  id: string;
  email?: string | null;
  email_confirmed_at?: string | null;
  user_metadata?: Record<string, unknown>;
}

/** Public bootstrap config — frontend calls this once on load. */
app.get('/config', (c) => {
  const url = process.env.SUPABASE_PROJECT_URL || '';
  const anon = process.env.SUPABASE_ANON_KEY || '';
  const configured = !!(url && anon);
  return c.json({
    project_url: url,
    anon_key: anon,
    configured,
  });
});

/**
 * Validate the access token by hitting Supabase's /auth/v1/user endpoint.
 * This delegates signature + expiry checks to Supabase itself, which is
 * correct given we already trust their auth service. Returns null on
 * any failure (invalid/expired token).
 */
async function verifySupabaseToken(accessToken: string): Promise<SupabaseUser | null> {
  const url = process.env.SUPABASE_PROJECT_URL;
  const anon = process.env.SUPABASE_ANON_KEY;
  if (!url || !anon) return null;
  try {
    const r = await fetch(`${url}/auth/v1/user`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        apikey: anon,
      },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) {
      log.warn('auth.supabase.verify_failed', { status: r.status });
      return null;
    }
    return (await r.json()) as SupabaseUser;
  } catch (err: any) {
    log.warn('auth.supabase.verify_error', { error: err?.message || String(err) });
    return null;
  }
}

/**
 * Upsert wallet + signup bonus for a fresh Axon user. Mirrors the
 * relevant slice of /v1/signup so a Supabase login can mint an account
 * without bouncing through the older signup path.
 *
 * Wallet provisioning uses the same provider abstraction as signup
 * (Turnkey by default, configurable). On failure we surface a 503-style
 * error to the caller.
 */
async function provisionUser(opts: {
  email: string;
  supabaseUserId: string;
}): Promise<{ ok: true; userId: string; rawKey: string; depositAddress: string } | { ok: false; error: string }> {
  // Generate the user id up-front so the wallet provider can derive a
  // deterministic address from it (matches signup.ts pattern).
  const userId = randomUUID();
  const provider = getWalletProvider();
  const deposit = await provider.createUserWallet(userId).catch((err) => {
    log.error('auth.supabase.wallet_failed', {
      email: opts.email,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  });
  if (!deposit) return { ok: false, error: 'wallet_provider_unavailable' };

  const rawKey = generateApiKey();
  const apiKeyHash = hashApiKey(rawKey);
  const apiKeyEncrypted = encrypt(rawKey);

  try {
    const [user] = await db
      .insert(users)
      .values({
        id: userId,
        email: opts.email,
        apiKeyHash,
        apiKeyEncrypted,
        supabaseUserId: opts.supabaseUserId,
        tier: 'free',
      })
      .returning();
    await db.insert(wallets).values({
      userId: user.id,
      address: deposit.address.toLowerCase(),
      balanceMicro: toMicro(SIGNUP_BONUS_USDC),
    });
    if (deposit.serializedBackup) {
      await db.insert(transactions).values({
        userId: user.id,
        type: 'bonus',
        amountMicro: 0n,
        meta: {
          event: 'wallet_provisioned',
          wallet_id: deposit.walletId,
          backup_enc: deposit.serializedBackup,
        },
      });
    }
    await db.insert(transactions).values({
      userId: user.id,
      type: 'bonus',
      amountMicro: toMicro(SIGNUP_BONUS_USDC),
      meta: { reason: 'supabase_signup_bonus', email: opts.email },
    });
    return { ok: true, userId: user.id, rawKey, depositAddress: deposit.address };
  } catch (err: any) {
    log.warn('auth.supabase.create_failed', {
      email: opts.email,
      error: err?.message || String(err),
    });
    return { ok: false, error: 'create_failed' };
  }
}

/**
 * Rotate an existing user's API key — used when an existing user logs
 * in via Supabase for the first time (apiKeyEncrypted is NULL because
 * they predate the column). The old hash stays valid for ROTATION_GRACE_MS
 * so any in-flight scripts using the old key don't get an instant 401.
 */
async function rotateKeyForUser(userId: string, prevHash: string): Promise<string> {
  const rawKey = generateApiKey();
  const newHash = hashApiKey(rawKey);
  const encrypted = encrypt(rawKey);
  await db
    .update(users)
    .set({
      apiKeyHash: newHash,
      apiKeyEncrypted: encrypted,
      prevApiKeyHash: prevHash,
      prevApiKeyExpiresAt: new Date(Date.now() + ROTATION_GRACE_MS),
    })
    .where(eq(users.id, userId));
  return rawKey;
}

/**
 * POST /v1/auth/supabase/exchange
 * Body: { access_token: string }
 *
 * Returns: { ok: true, api_key, user_id, rotated?, created? }
 *          | { error, message }
 */
app.post('/exchange', async (c) => {
  const body = await c.req.json().catch(() => ({} as any));
  const accessToken = String(body.access_token || '').trim();
  if (!accessToken) {
    return c.json({ error: 'missing_token', message: 'access_token is required' }, 400);
  }

  const supaUser = await verifySupabaseToken(accessToken);
  if (!supaUser) {
    return c.json({ error: 'invalid_token', message: 'Supabase token verification failed.' }, 401);
  }
  const email = (supaUser.email || '').toLowerCase().trim();
  if (!email) {
    return c.json(
      { error: 'no_email', message: 'Supabase user has no email — sign up with email auth first.' },
      400,
    );
  }
  if (!supaUser.email_confirmed_at) {
    return c.json(
      {
        error: 'email_not_confirmed',
        message: 'Confirme seu e-mail (procure por mensagem do Supabase) e tente de novo.',
      },
      403,
    );
  }

  // Match by supabase_user_id first (durable), then by email.
  let existing = await db
    .select()
    .from(users)
    .where(eq(users.supabaseUserId, supaUser.id))
    .limit(1)
    .then((rows) => rows[0]);

  if (!existing) {
    existing = await db
      .select()
      .from(users)
      .where(eq(users.email, email))
      .limit(1)
      .then((rows) => rows[0]);
  }

  if (existing) {
    if (existing.deletedAt) {
      return c.json({ error: 'account_deleted', message: 'Esta conta foi deletada.' }, 403);
    }
    // Backfill supabase_user_id if missing (first Supabase login of an
    // existing /v1/signup user matched purely by email).
    if (!existing.supabaseUserId) {
      await db
        .update(users)
        .set({ supabaseUserId: supaUser.id })
        .where(eq(users.id, existing.id))
        .catch(() => {});
    }
    // Return the persisted API key when we have it; otherwise rotate.
    if (existing.apiKeyEncrypted) {
      try {
        const apiKey = decrypt(existing.apiKeyEncrypted);
        return c.json({ ok: true, api_key: apiKey, user_id: existing.id, rotated: false, created: false });
      } catch {
        // Decryption failed (master key changed?) — fall through to rotate.
      }
    }
    const newKey = await rotateKeyForUser(existing.id, existing.apiKeyHash);
    return c.json({ ok: true, api_key: newKey, user_id: existing.id, rotated: true, created: false });
  }

  // Brand-new user — provision wallet + signup bonus.
  const created = await provisionUser({ email, supabaseUserId: supaUser.id });
  if (!created.ok) {
    return c.json({ error: created.error, message: 'Failed to create account.' }, 503);
  }

  // Welcome email — fire-and-forget so a slow Resend call never blocks login.
  // Mirrors the legacy /v1/signup path so users who arrive via Supabase auth
  // (the real signup flow today) get the same onboarding nudge.
  void (async () => {
    try {
      const { sendEmail } = await import('~/email/client');
      const { welcomeEmail } = await import('~/email/templates');
      const t = welcomeEmail({
        email,
        apiKey: created.rawKey,
        bonusUsdc: String(SIGNUP_BONUS_USDC),
        depositAddress: created.depositAddress,
      });
      await sendEmail({ to: email, subject: t.subject, html: t.html, text: t.text, tag: 'welcome' });
    } catch (err) {
      log.warn('auth.supabase.welcome_email_failed', {
        user_id: created.userId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  })();

  return c.json({ ok: true, api_key: created.rawKey, user_id: created.userId, rotated: false, created: true });
});

/**
 * POST /v1/auth/supabase/rotate
 *
 * Authenticated regenerate. Caller passes Supabase access_token AND the
 * current Axon API key (in x-api-key header). On success returns a new
 * api_key and stores it hashed+encrypted; previous hash becomes the
 * grace key for ROTATION_GRACE_MS. Used by the /account "Regenerar"
 * button.
 */
app.post('/rotate', async (c) => {
  const apiKey = c.req.header('x-api-key');
  const body = await c.req.json().catch(() => ({} as any));
  const accessToken = String(body.access_token || '').trim();
  if (!apiKey || !accessToken) {
    return c.json({ error: 'missing_credentials' }, 400);
  }
  const supaUser = await verifySupabaseToken(accessToken);
  if (!supaUser) {
    return c.json({ error: 'invalid_token' }, 401);
  }
  // Verify the api key belongs to a user matching the Supabase user.
  const expectedHash = hashApiKey(apiKey);
  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.apiKeyHash, expectedHash))
    .limit(1);
  if (!user || user.deletedAt) {
    return c.json({ error: 'invalid_api_key' }, 401);
  }
  if (user.supabaseUserId && user.supabaseUserId !== supaUser.id) {
    return c.json({ error: 'mismatch' }, 403);
  }
  const newKey = await rotateKeyForUser(user.id, expectedHash);
  return c.json({ ok: true, api_key: newKey, user_id: user.id });
});

export default app;
