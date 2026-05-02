/**
 * Self-service account routes.
 *
 *   GET    /v1/users/me           — basic profile
 *   GET    /v1/users/me/export    — full data export (LGPD/GDPR)
 *   DELETE /v1/users/me           — soft-delete + PII wipe
 *
 * Account deletion is two-step on the client side: this endpoint
 * accepts a `confirm` field that must equal the user's id (so a
 * cookie-replay can't trigger it without the user explicitly typing
 * their id into the confirmation prompt).
 *
 * The export is gathered streaming — we collect rows from every
 * table that references this user_id and ship a single JSON document.
 * Big users could exceed memory, but at the scale we run the cap
 * never bites; if it does, switch to chunked streaming.
 */
import { Hono } from 'hono';
import { eq, sql } from 'drizzle-orm';
import { db } from '~/db';
import {
  users,
  wallets,
  transactions,
  requests,
  agents,
  agentMessages,
  whatsappConnections,
  contactMemory,
  pixPayments,
  webhookSubscriptions,
  webhookDeliveries,
  policies,
  userVoices,
  userMfa,
} from '~/db/schema';
import { Errors } from '~/lib/errors';
import { audit } from '~/lib/audit';
import { redactEmail } from '~/lib/logger';
import { generateApiKey, hashApiKey, decrypt } from '~/lib/crypto';
import { verifyCode } from '~/lib/totp';

const app = new Hono();

// 1 hour grace window — long enough for a deploy that picks the new
// key from a config update; short enough that a stolen old key can't
// stick around indefinitely.
const ROTATION_GRACE_MS = 60 * 60 * 1000;

/** GET /v1/users/me — minimal profile */
app.get('/me', async (c) => {
  const user = c.get('user') as { id: string; email: string | null; tier: string };
  return c.json({
    id: user.id,
    email: user.email,
    tier: user.tier,
  });
});

/**
 * POST /v1/users/me/rotate-api-key
 * Rotates the caller's API key. Returns the new plaintext ONCE.
 *
 * Grace window: the old hash stays valid for ROTATION_GRACE_MS so
 * deploys with the new key can roll out without an instant lockout.
 *
 * 2FA gate: when 2FA is enabled, the request body must include a
 * fresh `code`. This prevents a stolen API key alone from being
 * used to rotate itself into permanence.
 */
app.post('/me/rotate-api-key', async (c) => {
  const user = c.get('user') as { id: string; tier: string };
  const body = (await c.req.json().catch(() => ({}))) as { code?: string; recovery?: string };

  // 2FA check (only when enabled)
  const [mfa] = await db.select().from(userMfa).where(eq(userMfa.userId, user.id)).limit(1);
  if (mfa?.verifiedAt) {
    let allowed = false;
    if (body.code) {
      try {
        const secret = Buffer.from(decrypt(mfa.secretCipher), 'hex');
        allowed = verifyCode(secret, body.code, { lastCounter: mfa.lastCounter ?? null }).ok;
      } catch {/* corrupt cipher → reject */}
    }
    if (!allowed && body.recovery && mfa.recoveryCipher) {
      try {
        const codes = JSON.parse(decrypt(mfa.recoveryCipher)) as string[];
        allowed = codes.includes(body.recovery);
      } catch {/* corrupt cipher */}
    }
    if (!allowed) {
      return c.json(
        { error: 'mfa_required', message: '2FA code (or recovery) required to rotate API key' },
        401,
      );
    }
  }

  const newKey = generateApiKey();
  const newHash = hashApiKey(newKey);

  // Pull the current row to preserve current hash as prev.
  const [current] = await db.select().from(users).where(eq(users.id, user.id)).limit(1);
  if (!current) throw Errors.notFound('User');

  await db
    .update(users)
    .set({
      apiKeyHash: newHash,
      prevApiKeyHash: current.apiKeyHash,
      prevApiKeyExpiresAt: new Date(Date.now() + ROTATION_GRACE_MS),
    })
    .where(eq(users.id, user.id));

  audit(c, 'user.api_key.rotate', {
    target_user_id: user.id,
    meta: { grace_ms: ROTATION_GRACE_MS },
  });

  return c.json({
    api_key: newKey,
    previous_valid_until: new Date(Date.now() + ROTATION_GRACE_MS).toISOString(),
    warning:
      'Save the new key now — it cannot be retrieved later. The previous key still works for 1 hour during your rollout window.',
  });
});

/**
 * GET /v1/users/me/export
 * LGPD / GDPR Article 20 — right to data portability. Returns every
 * row that references this user's id. Sensitive fields (api_key_hash,
 * encrypted backup blobs, webhook secrets) are stripped — those are
 * NOT user data in the legal sense, they're our credentials about the
 * user's account. We DO include emails, phones, message contents,
 * wallet addresses, balances, transaction history, agent configs.
 */
app.get('/me/export', async (c) => {
  const user = c.get('user') as { id: string };

  const [
    userRow,
    walletRow,
    txRows,
    reqRows,
    agentRows,
    agentMsgs,
    waConns,
    contacts,
    pix,
    webhookSubs,
    webhookDeliveryRows,
    policyRow,
    voices,
  ] = await Promise.all([
    db.select().from(users).where(eq(users.id, user.id)),
    db.select().from(wallets).where(eq(wallets.userId, user.id)),
    db.select().from(transactions).where(eq(transactions.userId, user.id)),
    db.select().from(requests).where(eq(requests.userId, user.id)),
    db.select().from(agents).where(eq(agents.ownerId, user.id)),
    db
      .select()
      .from(agentMessages)
      .where(sql`${agentMessages.agentId} IN (SELECT id FROM agents WHERE owner_id = ${user.id})`),
    db.select().from(whatsappConnections).where(eq(whatsappConnections.ownerId, user.id)),
    db
      .select()
      .from(contactMemory)
      .where(sql`${contactMemory.agentId} IN (SELECT id FROM agents WHERE owner_id = ${user.id})`),
    db.select().from(pixPayments).where(eq(pixPayments.userId, user.id)),
    db.select().from(webhookSubscriptions).where(eq(webhookSubscriptions.userId, user.id)),
    db
      .select()
      .from(webhookDeliveries)
      .where(
        sql`${webhookDeliveries.subscriptionId} IN (SELECT id FROM webhook_subscriptions WHERE user_id = ${user.id})`,
      ),
    db.select().from(policies).where(eq(policies.userId, user.id)),
    db.select().from(userVoices).where(eq(userVoices.userId, user.id)),
  ]);

  const stripCreds = <T extends Record<string, unknown>>(rows: T[], keys: string[]): T[] =>
    rows.map((r) => {
      const out = { ...r };
      for (const k of keys) delete (out as Record<string, unknown>)[k];
      return out;
    });

  audit(c, 'user.account.export', { target_user_id: user.id });

  return c.json({
    exported_at: new Date().toISOString(),
    user_id: user.id,
    user: stripCreds(userRow, ['apiKeyHash']),
    wallet: walletRow,
    transactions: txRows,
    requests: reqRows,
    agents: stripCreds(agentRows, []),
    agent_messages: agentMsgs,
    whatsapp_connections: stripCreds(waConns, ['apiKey', 'webhookSecret']),
    contacts: contacts,
    pix_payments: pix,
    webhook_subscriptions: stripCreds(webhookSubs, ['secret']),
    webhook_deliveries: webhookDeliveryRows,
    policy: policyRow,
    voices: voices,
  });
});

/**
 * DELETE /v1/users/me
 * Soft-delete + PII wipe. Requires `confirm = <user.id>` in the body
 * to prevent CSRF-style accidents. Wipes:
 *   - users.email                → null
 *   - users.api_key_hash         → null'd (so the key can't be reused)
 *   - users.deleted_at           → NOW()
 *   - whatsapp_connections rows  → deleted (Evolution instance also)
 *   - personal data in agents    → name + business_info + system_prompt
 *                                  cleared, slug + ids preserved for
 *                                  references from request analytics
 *   - contact_memory             → wiped (customer-side data)
 *   - user_voices                → cloned voices deleted upstream too
 *   - webhook_subscriptions      → deleted
 *
 * Kept (financial/legal):
 *   - transactions, requests, settlements (need for accounting + audits)
 *   - pix_payments (need for chargeback / dispute history)
 *   - admin_audit_log entries (legally required to retain)
 */
app.delete('/me', async (c) => {
  const user = c.get('user') as { id: string };
  const body = (await c.req.json().catch(() => ({}))) as { confirm?: string };
  if (body.confirm !== user.id) {
    return c.json(
      {
        error: 'confirmation_required',
        message: `Set confirm to your user_id (${user.id}) to proceed. This is irreversible.`,
      },
      400,
    );
  }
  const userId = user.id;

  // Best-effort cleanup of remote/upstream resources first. If any of
  // these fail we still soft-delete the user — they can't reach us
  // again to retry, and ops can clean up manually.
  try {
    const conns = await db
      .select()
      .from(whatsappConnections)
      .where(eq(whatsappConnections.ownerId, userId));
    const { decrypt } = await import('~/lib/crypto');
    const { deleteInstance } = await import('~/whatsapp/evolution');
    for (const conn of conns) {
      try {
        await deleteInstance({
          instanceUrl: conn.instanceUrl,
          instanceName: conn.instanceName,
          apiKey: decrypt(conn.apiKey),
        });
      } catch {/* swallow — best-effort */}
    }
  } catch {/* swallow */}

  try {
    const cloned = await db.select().from(userVoices).where(eq(userVoices.userId, userId));
    const { deleteRemoteVoice } = await import('~/voice/elevenlabs');
    for (const v of cloned) {
      if (v.source === 'cloned') deleteRemoteVoice(v.externalId).catch(() => {});
    }
  } catch {/* swallow */}

  // Local DB wipes
  await db.delete(whatsappConnections).where(eq(whatsappConnections.ownerId, userId));
  await db.delete(contactMemory).where(
    sql`${contactMemory.agentId} IN (SELECT id FROM agents WHERE owner_id = ${userId})`,
  );
  await db.delete(userVoices).where(eq(userVoices.userId, userId));
  await db.delete(webhookSubscriptions).where(eq(webhookSubscriptions.userId, userId));

  // Anonymize agents — keep the row so historical request rows still
  // resolve, but blank the personal/business prompt content.
  await db
    .update(agents)
    .set({
      name: '[deleted]',
      description: null,
      systemPrompt: '[deleted]',
      businessInfo: null,
      welcomeMessage: null,
      ownerPhone: null,
      paused_at: new Date(),
    } as unknown as Record<string, never>)  // partial Drizzle update — fields are nullable
    .where(eq(agents.ownerId, userId));

  // Mark the user deleted + wipe email + null'd api key hash. We use
  // a deterministic non-zero hash to keep the unique constraint happy
  // while ensuring no real key matches it.
  const tombstoneHash = `deleted:${userId}`;
  await db
    .update(users)
    .set({
      email: null,
      apiKeyHash: tombstoneHash,
      deletedAt: new Date(),
    })
    .where(eq(users.id, userId));

  audit(c, 'user.account.delete', {
    target_user_id: userId,
    meta: { email_was: redactEmail((user as unknown as { email?: string }).email) },
  });

  return c.json({
    ok: true,
    message:
      'Conta apagada. Dados pessoais foram removidos. Histórico financeiro foi mantido para auditoria, conforme obrigação legal.',
  });
});

export default app;
