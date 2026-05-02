/**
 * 2FA TOTP routes.
 *
 *   POST   /v1/auth/2fa/setup     — start setup; returns QR + secret
 *   POST   /v1/auth/2fa/verify    — confirm device with first code
 *   POST   /v1/auth/2fa/check     — verify a code at any time (uses
 *                                   on login flows; protects rotate
 *                                   key + delete account)
 *   GET    /v1/auth/2fa/status    — is 2FA on for me?
 *   DELETE /v1/auth/2fa           — disable (requires current code)
 *
 * Setup → verify is two-step: setup writes a secret with verifiedAt
 * NULL, the user proves they scanned by submitting a fresh code,
 * which sets verifiedAt. Until verifiedAt is set, login bypasses
 * the gate so a half-finished setup doesn't lock the user out.
 */
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { db } from '~/db';
import { userMfa, users } from '~/db/schema';
import { Errors } from '~/lib/errors';
import { encrypt, decrypt } from '~/lib/crypto';
import { audit } from '~/lib/audit';
import {
  generateSecret,
  otpauthUri,
  base32Encode,
  base32Decode,
  verifyCode,
  generateRecoveryCodes,
} from '~/lib/totp';

const app = new Hono();

const ISSUER = 'Axon';

app.get('/status', async (c) => {
  const user = c.get('user') as { id: string };
  const [row] = await db.select().from(userMfa).where(eq(userMfa.userId, user.id)).limit(1);
  return c.json({
    enabled: !!row,
    verified: !!row?.verifiedAt,
    set_up_at: row?.createdAt ?? null,
  });
});

/**
 * POST /v1/auth/2fa/setup
 * Generates a fresh secret + recovery codes. Stores ciphered. The
 * plaintext secret + recovery codes are returned ONCE (the user
 * pastes the secret/QR into their authenticator and saves the
 * recovery codes somewhere safe). After this endpoint returns,
 * the only way to read them is through the recovery flow.
 *
 * If the user already has a row, we OVERWRITE — generates a new
 * secret. Disable old one cleanly via DELETE first if you don't
 * want that behavior.
 */
app.post('/setup', async (c) => {
  const user = c.get('user') as { id: string; email: string | null };
  const secret = generateSecret();
  const codes = generateRecoveryCodes(10);
  const recoveryCipher = encrypt(JSON.stringify(codes));

  await db
    .insert(userMfa)
    .values({
      userId: user.id,
      secretCipher: encrypt(secret.toString('hex')),
      recoveryCipher,
      verifiedAt: null,
    })
    .onConflictDoUpdate({
      target: userMfa.userId,
      set: {
        secretCipher: encrypt(secret.toString('hex')),
        recoveryCipher,
        verifiedAt: null,
        lastCounter: null,
        updatedAt: new Date(),
      },
    });

  const label = user.email || `user-${user.id.slice(0, 8)}`;
  return c.json({
    secret_base32: base32Encode(secret),
    otpauth_uri: otpauthUri(secret, label, ISSUER),
    recovery_codes: codes,
    warning:
      'Save the recovery codes now. They are not retrievable later. Use one to disable 2FA if you lose your authenticator.',
  });
});

/**
 * POST /v1/auth/2fa/verify
 * Consumes one fresh code to confirm the secret was scanned correctly.
 * Sets verifiedAt → after this, any sensitive op MAY require a code.
 */
app.post('/verify', async (c) => {
  const user = c.get('user') as { id: string };
  const { code } = (await c.req.json().catch(() => ({}))) as { code?: string };
  if (!code) throw Errors.badRequest('code is required');

  const [row] = await db.select().from(userMfa).where(eq(userMfa.userId, user.id)).limit(1);
  if (!row) throw Errors.badRequest('2FA not set up — call /setup first');
  if (row.verifiedAt) throw Errors.badRequest('2FA already verified');

  const secret = Buffer.from(decrypt(row.secretCipher), 'hex');
  const r = verifyCode(secret, code, { lastCounter: row.lastCounter ?? null });
  if (!r.ok) throw Errors.badRequest('invalid code');

  await db
    .update(userMfa)
    .set({ verifiedAt: new Date(), lastCounter: r.counter ?? null, updatedAt: new Date() })
    .where(eq(userMfa.userId, user.id));

  audit(c, 'user.2fa.enable', { target_user_id: user.id });
  return c.json({ ok: true, verified: true });
});

/**
 * POST /v1/auth/2fa/check
 * Verifies a code without state changes. Sensitive endpoints (key
 * rotation, account delete) call this server-to-server style — the
 * client passes the code in the body of the original request, and
 * we delegate here.
 */
app.post('/check', async (c) => {
  const user = c.get('user') as { id: string };
  const { code } = (await c.req.json().catch(() => ({}))) as { code?: string };
  if (!code) return c.json({ ok: false, message: 'code required' }, 400);

  const [row] = await db.select().from(userMfa).where(eq(userMfa.userId, user.id)).limit(1);
  if (!row?.verifiedAt) return c.json({ ok: false, message: '2FA not enabled' }, 400);

  const secret = Buffer.from(decrypt(row.secretCipher), 'hex');
  const r = verifyCode(secret, code, { lastCounter: row.lastCounter ?? null });
  if (!r.ok) return c.json({ ok: false, message: 'invalid code' }, 401);

  await db
    .update(userMfa)
    .set({ lastCounter: r.counter ?? null, updatedAt: new Date() })
    .where(eq(userMfa.userId, user.id));

  return c.json({ ok: true });
});

/**
 * DELETE /v1/auth/2fa
 * Disable 2FA. Requires either the current code OR a recovery code,
 * so a stolen API key alone can't turn off the second factor.
 */
app.delete('/', async (c) => {
  const user = c.get('user') as { id: string };
  const { code, recovery } = (await c.req.json().catch(() => ({}))) as {
    code?: string;
    recovery?: string;
  };

  const [row] = await db.select().from(userMfa).where(eq(userMfa.userId, user.id)).limit(1);
  if (!row?.verifiedAt) return c.json({ ok: true, message: '2FA was not enabled' });

  let allowed = false;
  if (code) {
    const secret = Buffer.from(decrypt(row.secretCipher), 'hex');
    allowed = verifyCode(secret, code, { lastCounter: row.lastCounter ?? null }).ok;
  }
  if (!allowed && recovery && row.recoveryCipher) {
    try {
      const codes = JSON.parse(decrypt(row.recoveryCipher)) as string[];
      allowed = codes.includes(recovery);
    } catch {/* corrupt cipher → reject */}
  }
  if (!allowed) throw Errors.badRequest('valid code or recovery is required to disable 2FA');

  await db.delete(userMfa).where(eq(userMfa.userId, user.id));
  audit(c, 'user.2fa.disable', { target_user_id: user.id });
  return c.json({ ok: true });
});

// Bind the user-mfa route under /v1/auth/2fa from index.ts.
export default app;
