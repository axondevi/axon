/**
 * WhatsApp connection management + inbound message webhook.
 *
 * Owner-facing (authed):
 *   POST   /v1/agents/:id/whatsapp        → register an Evolution instance
 *   GET    /v1/agents/:id/whatsapp        → current connection status
 *   DELETE /v1/agents/:id/whatsapp        → disconnect (and remove webhook)
 *
 * Public (called by the Evolution server when a customer's contact
 * sends a WhatsApp message):
 *   POST   /v1/webhooks/whatsapp/:secret  → receive event, route to agent,
 *                                            answer back via Evolution sendText
 */
import { Hono } from 'hono';
import { eq, and, desc } from 'drizzle-orm';
import { randomBytes, createHash } from 'node:crypto';
import { db } from '~/db';
import { agents, users, whatsappConnections, agentMessages } from '~/db/schema';
import { Errors } from '~/lib/errors';
import { log } from '~/lib/logger';
import { encrypt, decrypt } from '~/lib/crypto';
import { checkInstance, setWebhook, sendText, sendMedia, sendVoice, connectInstance, createInstance, deleteInstance, fetchMessageMedia, extractInbound, extractCallEvent, rejectCall } from '~/whatsapp/evolution';
import { recordSentId, isSentByUs } from '~/whatsapp/sent-ids';
import { runAgent, type ChatMessage } from '~/agents/runtime';
import {
  getOrCreateMemory,
  buildMemoryContext,
  recordTurn,
  extractFactsFromTurn,
} from '~/agents/contact-memory';
import { pushToBuffer, mergeBufferedText, anyAudio, type BufferedMessage } from '~/whatsapp/buffer';
import { classifyIntent, pickRoutedAgentId, loadRoutedAgent, type RoutesTo } from '~/agents/intent-router';
import { contactMemory } from '~/db/schema';
import { judgeTurn, judgeArc, buildTraceString } from '~/agents/judge';
import {
  detectUsedFacts,
  detectBusinessInfoUsed,
  detectSummaryUsed,
  estimateTokens,
  contextExcerpt,
  type FactLike,
} from '~/agents/knowledge-use';

// ─── Owner-authed sub-router (mounted under /v1/agents) ────
export const ownerWhatsapp = new Hono();

// GET current connection
//
// "connected" here means BOTH of:
//   1. there is a whatsapp_connections row (an Evolution instance was provisioned)
//   2. that Evolution instance has finished pairing with WhatsApp (state="open")
//
// Provisioning the instance and pairing the phone are TWO separate steps —
// the row exists immediately after auto-provision, but `state` only flips
// to "open" once the customer scans the QR. Returning connected:true based
// purely on row existence makes the dashboard claim "WhatsApp connected"
// before the QR was scanned, hiding the actual pairing UI.
//
// We probe Evolution every GET to surface the live state. If the row
// exists but the instance isn't paired yet, return:
//   { connected:false, pending_pairing:true, instance_*, qr_base64?, pairing_code? }
// so the frontend can jump straight to the QR view without re-provisioning
// (which would create a duplicate instance).
ownerWhatsapp.get('/:id/whatsapp', async (c) => {
  const user = c.get('user') as { id: string };
  const agentId = c.req.param('id');
  const [a] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.ownerId, user.id)));
  if (!a) throw Errors.notFound('Agent');

  const [conn] = await db
    .select()
    .from(whatsappConnections)
    .where(eq(whatsappConnections.agentId, agentId))
    .limit(1);
  if (!conn) return c.json({ connected: false });

  // Probe Evolution for the live state. If we can't decrypt or reach it,
  // fall back to the stored status so we don't break the UI on a transient
  // outage — the customer will see whatever the last-known state was.
  let liveState: string | null = null;
  let qrBase64: string | undefined;
  let pairingCode: string | undefined;
  try {
    const apiKey = decrypt(conn.apiKey);
    const probe = await checkInstance({
      instanceUrl: conn.instanceUrl,
      instanceName: conn.instanceName,
      apiKey,
    });
    if (probe.ok) {
      liveState = (probe.status || '').toLowerCase();
      // If not yet paired, eagerly fetch the QR so the frontend doesn't
      // need a 2nd roundtrip to /qr — saves ~300ms of perceived latency.
      if (liveState && !['open', 'connected'].includes(liveState)) {
        const conn2 = await connectInstance({
          instanceUrl: conn.instanceUrl,
          instanceName: conn.instanceName,
          apiKey,
          phoneNumber: a.ownerPhone || undefined,
        }).catch(() => ({ ok: false } as const));
        if (conn2.ok) {
          qrBase64 = conn2.qrBase64;
          pairingCode = conn2.pairingCode;
        }
      }
    }
  } catch {
    // decrypt or network failure — keep liveState null, fall through to
    // stored status so the dashboard isn't blank on a brief Evolution flap.
  }

  // Default to NOT paired. Only flip to paired with POSITIVE evidence:
  //   1. The live probe says 'open' or 'connected', OR
  //   2. The probe failed BUT this row has received WhatsApp messages
  //      before (lastEventAt set) — so it must have been paired at
  //      some point.
  //
  // Falling back to conn.status would be wrong: the column defaults to
  // 'connected' on insert, so a fresh-but-unpaired row would look paired
  // any time the probe fails (e.g. cold-start of Evolution, transient
  // flap right after createInstance), causing the dashboard to flash
  // "connected" 3 seconds after the QR appears.
  const isPaired = liveState
    ? ['open', 'connected'].includes(liveState)
    : !!conn.lastEventAt;
  const newStatus = isPaired ? 'connected' : (liveState || 'pairing');
  if (newStatus !== conn.status) {
    db.update(whatsappConnections)
      .set({ status: newStatus, updatedAt: new Date() })
      .where(eq(whatsappConnections.id, conn.id))
      .catch(() => {});
  }

  return c.json({
    connected: isPaired,
    pending_pairing: !isPaired,
    instance_url: conn.instanceUrl,
    instance_name: conn.instanceName,
    status: newStatus,
    last_event_at: conn.lastEventAt,
    webhook_url: webhookUrlFor(c, conn.webhookSecret),
    owner_phone: a.ownerPhone || null,
    qr_base64: qrBase64,
    pairing_code: pairingCode,
  });
});

// POST connect
ownerWhatsapp.post('/:id/whatsapp', async (c) => {
  const user = c.get('user') as { id: string };
  const agentId = c.req.param('id');
  const [a] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.ownerId, user.id)));
  if (!a) throw Errors.notFound('Agent');
  if (a.payMode !== 'owner') {
    return c.json({ error: 'wrong_pay_mode', message: 'WhatsApp connections require pay_mode=owner.' }, 400);
  }

  const body = await c.req.json().catch(() => ({} as any));
  const instanceUrl = String(body.instance_url || '').trim().replace(/\/+$/, '');
  const instanceName = String(body.instance_name || '').trim();
  const apiKey = String(body.api_key || '').trim();
  // Owner phone is optional — but if provided, it MUST be digits only after
  // normalization (e.g. "+55 (11) 99543-2538" → "5511995432538"). When set,
  // an inbound match flips the agent to personal-assistant mode.
  const ownerPhoneRaw = String(body.owner_phone || '').trim();
  const ownerPhone = ownerPhoneRaw ? ownerPhoneRaw.replace(/\D/g, '') : null;
  if (ownerPhone && (ownerPhone.length < 10 || ownerPhone.length > 15)) {
    return c.json({ error: 'bad_request', message: 'owner_phone must be 10–15 digits (E.164 without +)' }, 400);
  }
  if (!instanceUrl || !instanceName || !apiKey) {
    return c.json({ error: 'bad_request', message: 'instance_url, instance_name, api_key are required' }, 400);
  }
  if (!/^https?:\/\//.test(instanceUrl)) {
    return c.json({ error: 'bad_request', message: 'instance_url must be http(s)://' }, 400);
  }
  // SSRF guard: BYO-Evolution registration accepts a user-controlled URL.
  // Without this, registering instance_url=http://169.254.169.254 would
  // make the platform probe (and on inbound, deliver) to cloud metadata.
  const { checkUrlSafe } = await import('~/lib/ssrf');
  const safe = checkUrlSafe(instanceUrl);
  if (!safe.ok) {
    return c.json({ error: 'bad_request', message: `instance_url rejected: ${safe.reason}` }, 400);
  }

  // 1. Probe the instance to make sure URL+key+name actually work
  const probe = await checkInstance({ instanceUrl, instanceName, apiKey });
  if (!probe.ok) {
    return c.json({ error: 'evolution_unreachable', message: probe.error || 'unknown' }, 502);
  }

  // 2a. Fail-loud check: owner_phone must NOT equal the WhatsApp number
  // the instance is paired to. If they're the same, EVERY inbound from
  // that number triggers owner-mode — the agent serves its private
  // assistant prompt to whichever real customer happens to text the
  // bot. Catastrophic in clinics / sales contexts. We refuse the
  // register and audit the attempt.
  if (ownerPhone && probe.pairedPhone) {
    const pairedDigits = probe.pairedPhone.replace(/\D/g, '');
    if (pairedDigits && pairedDigits === ownerPhone) {
      const { audit } = await import('~/lib/audit');
      audit(c, 'whatsapp.owner_phone.collision_blocked', {
        meta: {
          owner_phone_redacted: ownerPhone.slice(0, 4) + '***' + ownerPhone.slice(-4),
          paired_phone_redacted: pairedDigits.slice(0, 4) + '***' + pairedDigits.slice(-4),
          agent_id: agentId,
        },
      });
      return c.json(
        {
          error: 'owner_phone_collision',
          message:
            'owner_phone não pode ser o mesmo número da instância WhatsApp. Como o WhatsApp não recebe mensagens enviadas pra si mesmo, isso causaria o agente a tratar TODOS os clientes como dono.',
        },
        400,
      );
    }
  }

  // 2. (re)create the connection row
  const secret = randomBytes(24).toString('hex');
  const encrypted = encrypt(apiKey);
  const webhookUrl = webhookUrlFor(c, secret);

  // Replace any existing connection for this agent (one-per-agent invariant).
  // Initial status reflects the probe — if Evolution already says 'open' the
  // BYO instance is paired and we can mark connected; otherwise 'pairing' so
  // GET /whatsapp returns pending_pairing instead of a false-positive.
  const probeState = (probe.status || '').toLowerCase();
  const initialStatus = ['open', 'connected'].includes(probeState) ? 'connected' : 'pairing';
  await db.delete(whatsappConnections).where(eq(whatsappConnections.agentId, agentId));
  await db.insert(whatsappConnections).values({
    agentId,
    ownerId: user.id,
    instanceUrl,
    instanceName,
    apiKey: encrypted,
    webhookSecret: secret,
    status: initialStatus,
  });

  // Persist owner_phone on the agent (only if the caller provided one — we
  // never null out a previously-set value when the field is omitted).
  if (ownerPhone) {
    await db
      .update(agents)
      .set({ ownerPhone, updatedAt: new Date() })
      .where(eq(agents.id, agentId));
  }

  // 3. Register Axon's webhook on the Evolution instance
  const set = await setWebhook({ instanceUrl, instanceName, apiKey, webhookUrl });
  if (!set.ok) {
    // Roll back the row so the owner sees the error and can fix
    await db.delete(whatsappConnections).where(eq(whatsappConnections.webhookSecret, secret));
    return c.json({ error: 'webhook_register_failed', message: set.error || 'Could not register webhook' }, 502);
  }

  // ─── Pairing: if instance is not yet open, fetch QR + pairing code ─
  // The probe runs before this — its `status` tells us the state. We
  // tolerate "open" / "connected" interchangeably across Evolution versions.
  // For "close" / "connecting" / unknown, we proactively fetch the pairing
  // material so the dashboard can show it without a 2nd round-trip.
  const isOpen = ['open', 'connected'].includes((probe.status || '').toLowerCase());
  let qrBase64: string | undefined;
  let pairingCode: string | undefined;
  if (!isOpen) {
    const conn = await connectInstance({
      instanceUrl,
      instanceName,
      apiKey,
      // Pass owner phone if provided — Evolution uses it to format the
      // pairing code request when the user wants the "pair by number" flow.
      phoneNumber: ownerPhone || undefined,
    });
    if (conn.ok) {
      qrBase64 = conn.qrBase64;
      pairingCode = conn.pairingCode;
    }
    // Don't fail the whole request if pairing fetch failed — owner can hit
    // GET /:id/whatsapp/qr to retry.
  }

  return c.json({
    ok: true,
    connection: {
      instance_url: instanceUrl,
      instance_name: instanceName,
      status: probe.status || 'connected',
      webhook_url: webhookUrl,
      owner_phone: ownerPhone || a.ownerPhone || null,
      // Only present when not yet paired. Frontend renders QR PNG via:
      //   <img src="data:image/png;base64,${qr_base64}">
      // and shows pairing_code as the "Connect by phone" alternative.
      qr_base64: qrBase64,
      pairing_code: pairingCode,
    },
  });
});

// ─── Auto-provision ──────────────────────────────────────────
// Creates a fresh Evolution instance on the SHARED Axon Evolution server
// (no customer credentials needed). Customer just clicks "Connect WhatsApp",
// scans the returned QR — done. The hard parts (instance creation, webhook
// registration, per-instance API key encryption) all happen server-side.
//
// Requires AXON_EVOLUTION_URL + AXON_EVOLUTION_API_KEY to be configured.
// Falls back to BYO mode (existing POST /:id/whatsapp) when those are unset.
ownerWhatsapp.post('/:id/whatsapp/auto', async (c) => {
  const user = c.get('user') as { id: string };
  const agentId = c.req.param('id');
  const [a] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.ownerId, user.id)));
  if (!a) throw Errors.notFound('Agent');
  if (a.payMode !== 'owner') {
    return c.json({ error: 'wrong_pay_mode', message: 'WhatsApp connections require pay_mode=owner.' }, 400);
  }

  const sharedUrl = (process.env.AXON_EVOLUTION_URL || '').trim().replace(/\/+$/, '');
  const sharedKey = (process.env.AXON_EVOLUTION_API_KEY || '').trim();
  if (!sharedUrl || !sharedKey) {
    return c.json({
      error: 'auto_provision_unavailable',
      message: 'Axon Evolution server not configured. Use the manual flow with your own Evolution credentials.',
    }, 503);
  }

  const body = await c.req.json().catch(() => ({} as any));
  const ownerPhoneRaw = String(body.owner_phone || '').trim();
  const ownerPhone = ownerPhoneRaw ? ownerPhoneRaw.replace(/\D/g, '') : null;
  if (ownerPhone && (ownerPhone.length < 10 || ownerPhone.length > 15)) {
    return c.json({ error: 'bad_request', message: 'owner_phone must be 10–15 digits' }, 400);
  }

  // Generate a unique instance name: axon-<userId-prefix>-<base36ts>.
  // Keep it under 60 chars (Evolution limit) and DNS-safe (no dots/spaces).
  const instanceName = `axon-${user.id.slice(0, 8)}-${Date.now().toString(36)}`;
  const secret = randomBytes(24).toString('hex');
  const webhookUrl = webhookUrlFor(c, secret);

  // 1. Create instance on shared server (returns per-instance api key + first QR).
  const created = await createInstance({
    serverUrl: sharedUrl,
    globalApiKey: sharedKey,
    instanceName,
    webhookUrl,
  });
  if (!created.ok || !created.apiKey) {
    return c.json({ error: 'create_failed', message: created.error || 'unknown' }, 502);
  }

  // 2. Persist the connection. Use per-instance api key (created.apiKey),
  // NOT the global key — instance-isolated even on shared server.
  // Status starts at 'pairing' since the customer still has to scan the QR;
  // the webhook receiver flips it to 'connected' on first inbound message,
  // and GET /whatsapp re-probes Evolution if the row hasn't seen traffic.
  const encrypted = encrypt(created.apiKey);
  await db.delete(whatsappConnections).where(eq(whatsappConnections.agentId, agentId));
  await db.insert(whatsappConnections).values({
    agentId,
    ownerId: user.id,
    instanceUrl: sharedUrl,
    instanceName: created.instanceName!,
    apiKey: encrypted,
    webhookSecret: secret,
    status: 'pairing',
  });

  if (ownerPhone) {
    await db
      .update(agents)
      .set({ ownerPhone, updatedAt: new Date() })
      .where(eq(agents.id, agentId));
  }

  // 3. If createInstance didn't return a QR (rare), fall back to /instance/connect.
  let qrBase64 = created.qrBase64;
  let pairingCode = created.pairingCode;
  if (!qrBase64 && !pairingCode) {
    const conn = await connectInstance({
      instanceUrl: sharedUrl,
      instanceName: created.instanceName!,
      apiKey: created.apiKey,
      phoneNumber: ownerPhone || undefined,
    });
    if (conn.ok) {
      qrBase64 = conn.qrBase64;
      pairingCode = conn.pairingCode;
    }
  }

  return c.json({
    ok: true,
    auto_provisioned: true,
    connection: {
      instance_url: sharedUrl,
      instance_name: created.instanceName,
      status: 'connecting',
      webhook_url: webhookUrl,
      owner_phone: ownerPhone || a.ownerPhone || null,
      qr_base64: qrBase64,
      pairing_code: pairingCode,
    },
  });
});

// GET QR + pairing code on demand (for refresh after timeout, or for
// re-pairing without re-saving credentials). Owner-only.
ownerWhatsapp.get('/:id/whatsapp/qr', async (c) => {
  const user = c.get('user') as { id: string };
  const agentId = c.req.param('id');
  const [a] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.ownerId, user.id)));
  if (!a) throw Errors.notFound('Agent');

  const [conn] = await db
    .select()
    .from(whatsappConnections)
    .where(eq(whatsappConnections.agentId, agentId))
    .limit(1);
  if (!conn) return c.json({ error: 'no_connection' }, 404);

  let apiKey: string;
  try { apiKey = decrypt(conn.apiKey); }
  catch { return c.json({ error: 'cannot_decrypt' }, 500); }

  // Probe first — if already paired, no QR needed.
  const probe = await checkInstance({
    instanceUrl: conn.instanceUrl,
    instanceName: conn.instanceName,
    apiKey,
  });
  if (probe.ok && ['open', 'connected'].includes((probe.status || '').toLowerCase())) {
    return c.json({ status: probe.status, paired: true });
  }

  const result = await connectInstance({
    instanceUrl: conn.instanceUrl,
    instanceName: conn.instanceName,
    apiKey,
    phoneNumber: a.ownerPhone || undefined,
  });
  if (!result.ok) {
    return c.json({ error: 'pairing_fetch_failed', message: result.error }, 502);
  }
  return c.json({
    status: probe.status || 'unknown',
    paired: false,
    qr_base64: result.qrBase64,
    pairing_code: result.pairingCode,
  });
});

// DELETE disconnect — also tears down the Evolution-side instance to free
// resources on the shared server. We do this BEFORE the DB delete so that
// if Evolution rejects (offline, auth flap), the operator can retry; once
// the DB row is gone we lose the credentials needed to clean Evolution.
ownerWhatsapp.delete('/:id/whatsapp', async (c) => {
  const user = c.get('user') as { id: string };
  const agentId = c.req.param('id');
  const [a] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.ownerId, user.id)));
  if (!a) throw Errors.notFound('Agent');

  const [conn] = await db
    .select()
    .from(whatsappConnections)
    .where(eq(whatsappConnections.agentId, agentId))
    .limit(1);

  // Best-effort Evolution cleanup. Even if it fails (server offline, key
  // rotated, instance already gone), proceed with the DB delete — leaving
  // a zombie instance is much better than a stuck connection row.
  if (conn) {
    try {
      const apiKey = decrypt(conn.apiKey);
      const result = await deleteInstance({
        instanceUrl: conn.instanceUrl,
        instanceName: conn.instanceName,
        apiKey,
      });
      if (!result.ok) {
        // Log only — DON'T fail the disconnect.
        // (logger import already at top of file via routes that use it.)
      }
    } catch {
      // decrypt failure: key was lost / rotated. Drop the row anyway.
    }
  }

  await db.delete(whatsappConnections).where(eq(whatsappConnections.agentId, agentId));
  return c.json({ ok: true });
});

// ─── Public webhook receiver (mounted at /v1/webhooks/whatsapp) ────
export const publicWebhook = new Hono();

publicWebhook.post('/:secret', async (c) => {
  const secret = c.req.param('secret');
  const [conn] = await db
    .select()
    .from(whatsappConnections)
    .where(eq(whatsappConnections.webhookSecret, secret))
    .limit(1);
  if (!conn) {
    // Don't 404 — return 200 so a misconfigured webhook doesn't keep retrying
    return c.json({ ignored: true });
  }

  // Replay-guard: Evolution doesn't sign webhook bodies, so the path
  // secret is the only auth. If the secret leaks (Evolution logs, MITM
  // in a non-TLS dev setup, ex-employee), an attacker can replay old
  // payloads or fabricate new ones forever. We tighten the window:
  //  - Each delivery's message id is dedup'd in Redis for 10 min, so
  //    the same payload replayed beats `ignored: replay`.
  //  - We don't cryptographically verify (Evolution can't sign), but
  //    the replay window + status-flag check makes burst replay useless.
  const { redis } = await import('~/cache/redis');
  // Drain payload once so we can both inspect and forward it. Evolution
  // posts JSON; .json() throws on empty, hence the catch fallthrough.
  const rawBody = await c.req.text();
  let payload: unknown = null;
  try { payload = JSON.parse(rawBody); } catch { /* not-JSON tolerated below */ }
  // Compose a stable id: prefer Evolution's own message id, fall back to
  // a hash of the body (so non-message events still get dedup'd).
  const evMsgId =
    (payload as { data?: { key?: { id?: string } } } | null)?.data?.key?.id || '';
  const dedupKey = evMsgId
    ? `wa:replay:${conn.id}:${evMsgId}`
    : `wa:replay:${conn.id}:body:${createHash('sha256').update(rawBody).digest('hex').slice(0, 16)}`;
  const fresh = await redis.set(dedupKey, '1', 'EX', 600, 'NX');
  if (!fresh) {
    void import('~/lib/metrics').then(({ bumpCounter }) => {
      bumpCounter('axon_webhook_replay_total', { type: 'whatsapp' });
    });
    return c.json({ ignored: 'replay' });
  }
  // Owner can mark a connection 'disabled' to mute the agent without deleting
  // the row. Anything else (pairing, connecting, connected) means traffic is
  // welcome — and a real inbound proves the WhatsApp is actually paired, so
  // we can flip 'pairing' → 'connected' here too.
  if (conn.status === 'disabled') {
    return c.json({ ignored: 'disabled' });
  }

  // Update freshness ping + promote to 'connected' on first real event so
  // GET /whatsapp can short-circuit the probe path for traffic-bearing rows.
  db.update(whatsappConnections)
    .set({ lastEventAt: new Date(), status: 'connected' })
    .where(eq(whatsappConnections.id, conn.id))
    .catch(() => {});

  // ─── CALL event: caller dialed the WhatsApp number ───────────────
  // Baileys can't answer calls (no SRTP), so a normal call would just
  // ring out and feel like a dead number. We intercept the offer:
  //   1. Best-effort reject (so the caller doesn't sit on an endless ring)
  //   2. Send a voice memo redirect explaining the agent answers by audio
  // Same WhatsApp number, same thread — the redirect lands as a voice
  // message right after the missed-call notification.
  const callEv = extractCallEvent(payload);
  if (callEv && !callEv.fromMe && callEv.status === 'offer') {
    void handleIncomingCall({ c, conn, callEv }).catch((err) => {
      log.warn('whatsapp.call.redirect_failed', {
        error: err instanceof Error ? err.message : String(err),
        agent_id: conn.agentId,
      });
    });
    return c.json({ ok: true, call_redirected: true });
  }

  // Body already drained as `payload` above for the replay guard; reuse.
  const inbound = extractInbound(payload);
  if (!inbound) return c.json({ ignored: 'unsupported_event' });

  // ─── Human handoff detection ─────────────────────────────────────
  // fromMe=true on a webhook means the WhatsApp account itself sent the
  // message — but that account is doing TWO things: (a) us replying via
  // sendText, (b) the human owner picking up their phone and typing.
  // We tell them apart by message ID:
  //   - ID matches one we just sent → ignore (echo of our own send)
  //   - ID is unknown → human typed it → flip the contact into "human
  //     paused" mode for 30min so the agent stops talking over them.
  if (inbound.fromMe) {
    if (inbound.messageId && isSentByUs(inbound.messageId)) {
      return c.json({ ignored: 'echo' });
    }
    // Unknown fromMe → human just answered. Mute the agent for this
    // contact for 30min. Agent resumes automatically when the timer
    // expires (next inbound from this customer reactivates it).
    const targetAgentId = conn.agentId;
    const pauseUntil = new Date(Date.now() + 30 * 60 * 1000);
    db.update(contactMemory)
      .set({ humanPausedUntil: pauseUntil, updatedAt: new Date() })
      .where(and(eq(contactMemory.agentId, targetAgentId), eq(contactMemory.phone, inbound.phone)))
      .catch(() => {});
    return c.json({ ignored: 'human_handoff', paused_until: pauseUntil.toISOString() });
  }

  // Look up the agent + contact memory once so we can early-out on
  // pause/handoff without doing the expensive media-fetch + LLM work.
  const [agentRow] = await db.select().from(agents).where(eq(agents.id, conn.agentId)).limit(1);
  if (!agentRow) return c.json({ ignored: 'agent_missing' });

  // Owner-set global pause from the dashboard. While paused_at is set,
  // every inbound is dropped — connection stays alive, agent stays mute.
  if (agentRow.pausedAt) {
    return c.json({ ignored: 'agent_paused' });
  }

  // Per-contact human handoff. If the owner replied manually within the
  // last 30min, stay quiet for that customer. Cleared automatically when
  // the timestamp passes.
  const [memRow] = await db.select().from(contactMemory)
    .where(and(eq(contactMemory.agentId, agentRow.id), eq(contactMemory.phone, inbound.phone)))
    .limit(1);
  if (memRow?.humanPausedUntil && memRow.humanPausedUntil.getTime() > Date.now()) {
    return c.json({ ignored: 'human_handoff_active', until: memRow.humanPausedUntil.toISOString() });
  }

  // ─── Decode the API key once, reused for media fetch + reply ───────
  let connApiKey: string;
  try {
    connApiKey = decrypt(conn.apiKey);
  } catch {
    return c.json({ ignored: 'cannot_decrypt_key' });
  }

  // ─── Media inbound: image / audio → describe / transcribe ───────────
  // The text the agent will see in `inbound.text` gets enriched here:
  //   image → "[CLIENTE ENVIOU FOTO] <description>. Caption: <caption>"
  //   audio → "[CLIENTE ENVIOU ÁUDIO] <transcript>"
  // The agent then responds normally to that enriched text.
  let inboundText = inbound.text;
  let userSentAudio = false;
  // Set when an image / PDF is successfully fetched + extracted. The
  // buffer carries this through to processBufferedTurn, which fires
  // saveContactDocument fire-and-forget after contact_memory is loaded.
  let mediaForVault: import('~/whatsapp/buffer').BufferedMessage['mediaForVault'] = undefined;
  if (inbound.kind === 'image' && inbound.messageKey && inbound.messageRaw) {
    try {
      const mediaStart = Date.now();
      const media = await fetchMessageMedia({
        instanceUrl: conn.instanceUrl,
        instanceName: conn.instanceName,
        apiKey: connApiKey,
        message: inbound.messageRaw,
        messageKey: inbound.messageKey,
      });
      log.info('whatsapp.media.image', {
        ok: media.ok,
        ms: Date.now() - mediaStart,
        bytes: media.bytes?.length ?? 0,
        mime: media.mimeType ?? null,
        error: media.error ?? null,
      });
      if (media.ok && media.bytes && media.mimeType) {
        const { describeImage } = await import('~/llm/vision');
        const desc = await describeImage({
          imageBytes: media.bytes,
          mimeType: media.mimeType,
          contextHint: inbound.text || undefined,
        });
        if (desc.ok && desc.description) {
          inboundText = `[CLIENTE ENVIOU FOTO]\nDescrição automática: ${desc.description}` +
            (inbound.text ? `\nLegenda do cliente: "${inbound.text}"` : '');
          // Capture for the vault — the bytes + extraction become a row
          // on contact_documents after the turn is dispatched.
          mediaForVault = {
            bytes: media.bytes,
            mimeType: media.mimeType,
            filename: undefined,
            callerCaption: inbound.text || undefined,
            extractedText: desc.description,
          };
        } else {
          // The agent will see this enriched user-message and reply
          // accordingly — natural language, not the bracketed system
          // marker. Picks one of three messages so the same user
          // doesn't get the identical fallback line repeatedly when
          // they retry. Audit + counter so ops can spot the issue
          // before the user reports it.
          log.warn('whatsapp.image.describe_failed', {
            error: desc.error ?? null,
            skipped: !!desc.skipped,
            mime: media.mimeType,
            bytes: media.bytes.length,
            agent_id: conn.agentId,
          });
          const callerCaption = inbound.text || '';
          if (callerCaption) {
            inboundText = `[CLIENTE ENVIOU UMA FOTO com a legenda] ${callerCaption}`;
          } else {
            inboundText =
              '[CLIENTE ENVIOU UMA FOTO sem legenda — peça gentilmente pra ele descrever em uma frase o que tá na imagem ou enviar de novo.]';
          }
        }
      } else {
        // Download itself failed — Evolution returned no bytes. Tell the
        // agent to ask gently, same as above.
        inboundText = inbound.text ||
          '[CLIENTE ENVIOU UMA FOTO mas não consegui baixar — peça pra ele tentar enviar de novo, ou descrever em texto.]';
      }
    } catch (err) {
      log.warn('whatsapp.image.exception', {
        error: err instanceof Error ? err.message : String(err),
        agent_id: conn.agentId,
      });
      inboundText = inbound.text || '[CLIENTE ENVIOU UMA FOTO — peça pra ele descrever em texto.]';
    }
  }
  if (inbound.kind === 'audio' && inbound.messageKey && inbound.messageRaw) {
    userSentAudio = true;
    try {
      const media = await fetchMessageMedia({
        instanceUrl: conn.instanceUrl,
        instanceName: conn.instanceName,
        apiKey: connApiKey,
        message: inbound.messageRaw,
        messageKey: inbound.messageKey,
      });
      if (media.ok && media.bytes && media.mimeType) {
        const { transcribeAudio } = await import('~/voice/deepgram');
        const tr = await transcribeAudio({
          audioBytes: media.bytes,
          mimeType: media.mimeType,
        });
        if (tr.ok && tr.transcript) {
          inboundText = `[CLIENTE ENVIOU ÁUDIO]\nTranscrição: "${tr.transcript}"`;
        } else {
          inboundText = '[CLIENTE ENVIOU ÁUDIO mas não consegui transcrever — peça pra ele escrever ou tentar de novo.]';
        }
      }
    } catch {
      inboundText = '[CLIENTE ENVIOU ÁUDIO — não consegui baixar.]';
    }
  }
  // ─── PDF / document inbound: extract text + send to vault ──────
  // Only PDFs are processed for now (Gemini multimodal handles inline_data
  // mime=application/pdf directly). docx / xlsx / etc. fall through to a
  // generic enrichment so the LLM at least knows something was sent —
  // future work: convert via libreoffice or similar. The vault still
  // saves the original file for the owner to download.
  if (inbound.kind === 'document' && inbound.messageKey && inbound.messageRaw) {
    try {
      const media = await fetchMessageMedia({
        instanceUrl: conn.instanceUrl,
        instanceName: conn.instanceName,
        apiKey: connApiKey,
        message: inbound.messageRaw,
        messageKey: inbound.messageKey,
      });
      const docMime = inbound.documentMimeType || media.mimeType || 'application/octet-stream';
      const docFilename = inbound.documentFilename || undefined;
      log.info('whatsapp.media.document', {
        ok: media.ok,
        bytes: media.bytes?.length ?? 0,
        mime: docMime,
        filename: docFilename || null,
      });
      if (media.ok && media.bytes) {
        const isPdf = /^application\/pdf\b/i.test(docMime);
        let extracted = '';
        if (isPdf) {
          const { describePdf } = await import('~/llm/vision');
          const r = await describePdf({
            pdfBytes: media.bytes,
            contextHint: inbound.text || undefined,
            filename: docFilename,
          });
          if (r.ok && r.description) {
            extracted = r.description;
            inboundText = `[CLIENTE ENVIOU PDF${docFilename ? ` "${docFilename}"` : ''}]\nConteúdo: ${r.description}` +
              (inbound.text ? `\nLegenda do cliente: "${inbound.text}"` : '');
          }
        }
        if (!extracted) {
          // Either non-PDF doc or PDF extraction failed — still acknowledge
          // and stash for the vault. Filename + caption guide the agent.
          const fileLabel = docFilename ? ` "${docFilename}"` : '';
          inboundText = `[CLIENTE ENVIOU DOCUMENTO${fileLabel}${docMime ? ` (${docMime})` : ''}]` +
            (inbound.text ? `\nLegenda do cliente: "${inbound.text}"` : '');
        }
        mediaForVault = {
          bytes: media.bytes,
          mimeType: docMime,
          filename: docFilename,
          callerCaption: inbound.text || undefined,
          extractedText: extracted || (inbound.text || `Documento ${docFilename || docMime}`),
        };
      } else {
        inboundText = inbound.text ||
          '[CLIENTE ENVIOU DOCUMENTO mas não consegui baixar — peça pra ele tentar enviar de novo.]';
      }
    } catch (err) {
      log.warn('whatsapp.document.exception', {
        error: err instanceof Error ? err.message : String(err),
        agent_id: conn.agentId,
      });
      inboundText = '[CLIENTE ENVIOU DOCUMENTO — não consegui processar.]';
    }
  }

  // Resolve agent + owner — needed to compute the session bucket BEFORE
  // we decide whether to buffer (owner conversations live in their own
  // bucket so they never get merged with a customer's burst). agentRow
  // was already loaded above for the pause/handoff checks.
  const a = agentRow;
  if (!a.public) return c.json({ ignored: 'agent_inactive' });

  const inboundDigits = inbound.phone.replace(/\D/g, '');
  const ownerDigits = (a.ownerPhone || '').replace(/\D/g, '');
  const isOwner = ownerDigits.length > 0 && inboundDigits === ownerDigits;
  const sessionId = isOwner ? `wa-owner:${inbound.phone}` : `wa:${inbound.phone}`;

  // Counter every owner-mode flip — sudden spike or unexpected slug
  // means a bad owner_phone config (or, if our checkInstance gap let
  // it through, a leak). Watch via /metrics.
  if (isOwner) {
    void import('~/lib/metrics').then(({ bumpCounter }) => {
      bumpCounter('axon_whatsapp_owner_mode_total', { agent: a.slug });
    });
  }

  // ─── Buffer & debounce ─────────────────────────────────────
  // Real users hit "send" 2-3 times in a row ("Oi" → "estou procurando" →
  // "pra minha irmã"). Without buffering, three webhooks fire in parallel,
  // each reads an empty history, the agent answers "Que bom ter você
  // aqui!" three times. With a 3s debounce window, all bubbles merge into
  // ONE LLM turn that sees the full thought.
  //
  // We push to the in-memory buffer, return 200 to Evolution immediately,
  // and let the flush callback do the heavy lifting (history load, LLM
  // call, image/Pix/voice/text replies). The agent + owner are scoped
  // into the closure so the callback has everything it needs.
  pushToBuffer(
    sessionId,
    {
      inbound,
      inboundText,
      receivedAt: Date.now(),
      userSentAudio,
      mediaForVault,
    },
    async (_sk, msgs) => {
      await processBufferedTurn({
        c,
        msgs,
        conn,
        connApiKey,
        agent: a,
        isOwner,
        sessionId,
      });
    },
  );

  // Webhook always returns 200 immediately — Evolution doesn't need to
  // wait for the agent. Reply arrives out-of-band over the WhatsApp socket.
  return c.json({ ok: true, buffered: true });
});

/**
 * Process a flushed batch of buffered messages as ONE conversation turn.
 *
 * msgs is everything the user typed during the debounce window — usually
 * 1, sometimes 2-3 bubbles. We merge their text, load history, run the
 * agent, persist both sides of the turn, and send the reply (image / Pix /
 * voice / text) using the same channels as the original handler.
 *
 * Heavy work happens here, NOT in the webhook handler — so Evolution gets
 * its 200 back in <100ms even when an LLM call takes 8s.
 */
async function processBufferedTurn(opts: {
  c: any;
  msgs: BufferedMessage[];
  conn: typeof whatsappConnections.$inferSelect;
  connApiKey: string;
  agent: typeof agents.$inferSelect;
  isOwner: boolean;
  sessionId: string;
}): Promise<void> {
  const { c, msgs, conn, connApiKey, agent: a, isOwner, sessionId } = opts;
  if (msgs.length === 0) return;

  // Use the latest message's phone/pushName — they're all from the same
  // contact (sessionId guarantees that), so any one works. Latest is the
  // most up-to-date pushName if WhatsApp profile changed.
  const latest = msgs[msgs.length - 1];
  const inbound = latest.inbound;
  const userSentAudio = anyAudio(msgs);
  const mergedText = mergeBufferedText(msgs);

  // ─── Re-check pause/handoff right before running the LLM ───────────
  // The pause/handoff check at the webhook entry point happened up to
  // 3-10s ago (buffer debounce + LLM warm-up). The owner could have
  // toggled "Pausar" on the dashboard in the meantime, or the handoff
  // window could have shifted. Re-fetching the agent + contact memory
  // here is cheap (two indexed lookups) and prevents the worst surprise:
  // an agent answering AFTER the owner muted it.
  const [freshAgent] = await db.select().from(agents).where(eq(agents.id, a.id)).limit(1);
  if (!freshAgent) return;
  if (freshAgent.pausedAt) {
    return;  // owner paused while message was buffering — drop silently
  }
  const [freshMem] = await db.select().from(contactMemory)
    .where(and(eq(contactMemory.agentId, a.id), eq(contactMemory.phone, inbound.phone)))
    .limit(1);
  if (freshMem?.humanPausedUntil && freshMem.humanPausedUntil.getTime() > Date.now()) {
    return;  // human took over while message was buffering — drop silently
  }

  const [owner] = await db.select().from(users).where(eq(users.id, a.ownerId)).limit(1);
  if (!owner) return;

  // Build conversation history. Owner conversations get a separate session
  // bucket so the personal-assistant history doesn't leak into customer-
  // facing turns (and vice-versa). The bucket was already chosen by the
  // caller via sessionId.
  const history = await db
    .select()
    .from(agentMessages)
    .where(and(eq(agentMessages.agentId, a.id), eq(agentMessages.sessionId, sessionId)))
    .orderBy(desc(agentMessages.createdAt))
    .limit(20);
  const priorMessages: ChatMessage[] = history
    .reverse()
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));

  const messages: ChatMessage[] = [...priorMessages, { role: 'user', content: mergedText }];

  // ─── First-contact spoken greeting (fire-and-forget) ──────────────
  // Brand-new contact gets a quick voice memo introducing the agent —
  // the same way a real attendant would say "oi, sou a Camila, como
  // posso ajudar?" before the real conversation starts. We kick this
  // off in parallel with the LLM call (which takes 2-5s), then await
  // it right before the actual reply so the greeting always lands
  // first. Skipped for owner mode (no point introducing yourself to
  // your own boss) and when voice is disabled on the agent.
  const isFirstContact = priorMessages.length === 0 && !isOwner;
  const voiceEnabledOnAgent = (a as { voiceEnabled?: boolean }).voiceEnabled !== false;
  const greetingPromise: Promise<void> | null =
    isFirstContact && voiceEnabledOnAgent
      ? sendFirstContactGreeting({
          conn,
          apiKey: connApiKey,
          agent: a,
          callerPhone: inbound.phone,
        })
      : null;

  // ─── System prompt assembly ────────────────────────────────
  // Owner mode: replace the public persona with a personal-assistant prompt.
  // Customer mode: keep the configured persona + inject contact memory.
  let augmentedSystemPrompt: string;
  let memory: Awaited<ReturnType<typeof getOrCreateMemory>> | null = null;
  if (isOwner) {
    // Owner também enxerga o business_info que ele mesmo configurou —
    // útil pra perguntas tipo "qual o endereço que tá lá?" ou pra testar
    // como a agente responderia a um cliente. Sem isso o owner-mode
    // ignorava dados que o próprio dono tinha cadastrado no painel.
    const ownerBusinessBlock = (a.businessInfo && a.businessInfo.trim())
      ? `\n\n## Dados do negócio que o dono cadastrou (use como referência se ele perguntar)\n${a.businessInfo.trim()}`
      : '';
    augmentedSystemPrompt = [
      `Você é o assistente pessoal de ${a.name ? `"${a.name}"` : 'do dono deste agente'}.`,
      `Está conversando DIRETAMENTE com o dono (não com um cliente).`,
      `Trate-o de forma direta, informal, em português. Sem persona de atendimento ao público.`,
      ``,
      `Capacidades disponíveis (use à vontade quando ele pedir):`,
      `- Gerar imagens a partir de descrições (use a tool generate_image; traduza o pedido para inglês detalhado antes de chamar — Stable Diffusion XL responde melhor em inglês).`,
      `- Pesquisar na web, raspar URLs, buscar Wikipedia/HN.`,
      `- Consultar CNPJ/CEP, clima, cotações, cripto, datas.`,
      ``,
      `Quando ele pedir uma imagem ("gera uma foto de X", "faz uma imagem de Y"):`,
      `1. Chame generate_image com um prompt em inglês BEM detalhado (estilo, iluminação, composição, qualidade).`,
      `2. A imagem é entregue automaticamente pelo WhatsApp — você só precisa confirmar em PT-BR ("Pronto, mandei aí 📸").`,
      `3. NÃO tente descrever pixels nem inventar URLs — só confirme.`,
      ``,
      `Skip o "||" multi-bolha — fala normal, frase única quando der.`,
    ].join('\n') + ownerBusinessBlock;
  } else {
    // WhatsApp inbound has no URL ?ref=, so first-touch attribution can
    // only come from a different channel (web /agent/:slug?ref=...). Pass
    // null here — getOrCreateMemory keeps any earlier attribution intact.
    memory = await getOrCreateMemory(a.id, inbound.phone, inbound.pushName, null).catch(() => null);
    const memoryContext = memory ? buildMemoryContext(memory) : '';

    // Owner-curated business info (address, hours, prices, etc) is
    // injected RIGHT AFTER the role prompt so the LLM treats it as
    // ground truth when answering "qual o endereço?", "quanto custa?",
    // etc — instead of saying "não tenho essa informação".
    const businessBlock = (a.businessInfo && a.businessInfo.trim())
      ? `\n\n## Informações do negócio (use estas como verdade ao responder o cliente)\n${a.businessInfo.trim()}`
      : '';

    augmentedSystemPrompt = `${a.systemPrompt}${businessBlock}` +
      (memoryContext ? `\n\n## O que você sabe sobre este contato\n${memoryContext}` : '');

    // Affiliate payout (fire-and-forget). Idempotent — if already paid
    // or no referrer, this is a single SELECT and returns immediately.
    if (memory && a.affiliateEnabled && a.affiliatePayoutMicro > 0n && memory.referredByUserId && !memory.affiliatePaidAt) {
      const { payoutAffiliateIfPending } = await import('~/affiliates');
      void payoutAffiliateIfPending({ agentId: a.id, contactId: memory.id }).catch(() => {});
    }

    // ─── Document vault (silent CRM persistence) ───────────────────
    // Any photo / PDF the customer sent in this buffered batch gets
    // uploaded to R2 + classified + indexed on contact_documents.
    // Fire-and-forget so upload latency / classifier blips don't block
    // the agent reply. Only runs in customer mode (owner sends to their
    // own bot for testing — no point indexing those).
    if (memory) {
      for (const m of msgs) {
        const v = m.mediaForVault;
        if (!v) continue;
        void (async () => {
          try {
            const { saveContactDocument } = await import('~/whatsapp/document-vault');
            await saveContactDocument({
              agentId: a.id,
              contactMemoryId: memory!.id,
              bytes: v.bytes,
              mimeType: v.mimeType,
              filename: v.filename,
              callerCaption: v.callerCaption,
              extractedText: v.extractedText,
            });
          } catch (err) {
            log.warn('whatsapp.document_vault.exception', {
              error: err instanceof Error ? err.message : String(err),
              agent_id: a.id,
            });
          }
        })();
      }
    }
  }

  // ─── Smart routing: classify intent → route to specialized agent ─────
  // If the connected agent has `routes_to` configured (i.e. acts as a
  // "front door"), pick a specialized agent based on the customer's intent.
  // Sticky: once classified, every subsequent turn from this contact uses
  // the same routed agent (stored in contact_memory.routedAgentId) so we
  // don't reclassify per turn — the customer's experience stays coherent.
  //
  // Owner mode skips routing entirely — when the OWNER is talking, they
  // get the personal-assistant prompt directly, no triage.
  let runtimeAgent = a;
  // Captured for the brain UI — the intent verdict that drove this turn,
  // even when no routing was configured. null means "not classified".
  let traceIntent: string | null = null;
  let traceRoutedAgentName: string | null = null;
  if (!isOwner && memory && a.routesTo) {
    let routedId: string | null = null;
    let intent = (memory.routeIntent as 'sales' | 'personal' | 'support' | 'unknown' | null) || null;

    // Already routed in a previous turn → reuse without reclassifying.
    if (memory.routedAgentId) {
      routedId = memory.routedAgentId as string;
      traceIntent = intent;
    } else {
      // First time seeing routing-enabled traffic for this contact: classify
      // and persist. classifyIntent ~300ms — kept BEFORE runAgent so the
      // specialized agent's full prompt+persona+tools all take effect on
      // this very turn (not the next one).
      intent = await classifyIntent(mergedText);
      traceIntent = intent;
      const target = pickRoutedAgentId(a.routesTo as RoutesTo, intent);
      if (target) {
        routedId = target;
        // Fire-and-forget DB update — failure here just means we'll
        // reclassify next turn, no user-visible impact.
        db.update(contactMemory)
          .set({ routedAgentId: target, routeIntent: intent, updatedAt: new Date() })
          .where(eq(contactMemory.id, memory.id))
          .catch(() => {});
      }
    }

    if (routedId) {
      const routed = await loadRoutedAgent({ agentId: routedId, ownerId: a.ownerId }).catch(() => null);
      if (routed) {
        // The routed agent has its OWN paused_at. If the owner muted the
        // specialist (e.g. clinic receptionist agent paused for the night)
        // we must drop the message even though the front-door agent is
        // active — otherwise pause is leaky in any routes_to setup.
        if ((routed as any).pausedAt) {
          return;
        }
        runtimeAgent = routed;
        traceRoutedAgentName = routed.name || null;
        // Re-augment system prompt using the routed agent's prompt — but
        // KEEP the contact memory context block + the routed agent's own
        // businessInfo (address, hours, prices, etc).
        const memoryContext = buildMemoryContext(memory);
        const routedBusiness = ((routed as any).businessInfo && (routed as any).businessInfo.trim())
          ? `\n\n## Informações do negócio (use estas como verdade ao responder o cliente)\n${(routed as any).businessInfo.trim()}`
          : '';
        augmentedSystemPrompt = `${routed.systemPrompt}${routedBusiness}` +
          (memoryContext ? `\n\n## O que você sabe sobre este contato\n${memoryContext}` : '');
      }
    }
  }

  // Owner gets a superset of tools (image gen + research stack) regardless
  // of the agent's configured allowedTools — those are for the public persona.
  const baseTools = Array.isArray(runtimeAgent.allowedTools) ? (runtimeAgent.allowedTools as string[]) : [];
  const ownerExtraTools = [
    'generate_image',
    'search_web',
    'scrape_url',
    'wikipedia_summary',
    'lookup_cnpj',
    'lookup_cep',
    'current_weather',
    'crypto_price',
    'convert_currency',
  ];
  const effectiveTools = isOwner
    ? Array.from(new Set([...baseTools, ...ownerExtraTools]))
    : baseTools;

  // ─── Capability guards ────────────────────────────────────────
  // Stop the agent from claiming it'll do things the toolkit doesn't
  // support. Without this, the LLM happily promises "vou gerar uma
  // imagem, aguarde" then sits silent because generate_image isn't in
  // its tools array — the customer waits forever and the judge flags
  // alucinou:true. Append explicit "NÃO posso fazer X" lines for every
  // sensitive capability NOT in the effective toolkit.
  // Capability boundaries split into two camps so the LLM doesn't
  // confuse "refuse generation request" with "react to received media":
  //
  //   refuseLines      → things the agent CAN'T do (generate image / pix /
  //                      web search). Trailing instruction: REFUSE.
  //   mustReactLines   → things the agent MUST do when input arrives
  //                      (acknowledge sent photos/audio). Trailing
  //                      instruction: REACT, never deflect.
  //
  // Previously these were one list under "REGRAS DURAS" with a trailing
  // "REFUSE educadamente" — which polluted the photo-react carve-out
  // with refusal language and made the agent reply "não posso receber
  // exames" to clinic clients sending exam photos. Splitting fixes it.
  const refuseLines: string[] = [];
  const mustReactLines: string[] = [];

  if (!effectiveTools.includes('generate_image')) {
    refuseLines.push(
      '- **Imagens (geração)**: você NÃO gera, edita nem desenha imagens NOVAS. Se o cliente PEDIR pra você criar/gerar/desenhar/produzir uma imagem ("gera uma foto de X", "faz um desenho de Y"), RECUSE educadamente e ofereça alternativa em texto. NUNCA escreva "vou gerar", "aguarde a imagem", "estou criando".',
    );
  }
  if (!effectiveTools.includes('generate_pix')) {
    refuseLines.push(
      '- **Pagamento Pix in-chat**: você NÃO gera QR Pix. Se o cliente quiser pagar, oriente a entrar em contato com o atendente humano ou explicar o método de pagamento configurado.',
    );
  }
  if (!effectiveTools.includes('search_web') && !effectiveTools.includes('exa_search')) {
    refuseLines.push(
      '- **Pesquisa web**: você NÃO pesquisa na internet. Responda apenas com base no que está nas Informações do negócio + memória do contato. Se o cliente perguntar algo que dependa de info externa, diga que não tem essa informação.',
    );
  }

  // Sent-photo reaction is ALWAYS required (independent of generate_image
  // capability). Vision describes the image and inlines the description
  // into the user message. The agent must read it and respond about the
  // content — not deflect to its role, not refuse, not ask for a verbal
  // description (the description is already there).
  mustReactLines.push(
    '- **Foto que o cliente ENVIOU**: mensagens começando com `[CLIENTE ENVIOU FOTO]` significam que ele mandou uma imagem e a descrição automática (o que aparece na foto) vem logo depois. **Trate como se você tivesse visto com seus próprios olhos.** A PRIMEIRA frase DEVE mencionar especificamente o que está na foto (cite detalhes concretos: cor, objeto, pessoa, documento, número, valor, medicamento, data, conteúdo do texto). SÓ DEPOIS redirecione/pergunte/peça contexto. PROIBIDO: "não posso receber fotos/exames/imagens por aqui", "manda em texto", "descreva em palavras". A foto JÁ está aqui, com descrição. Você TEM que trabalhar com ela. Esta regra VENCE qualquer instrução de persona ou business_info que mande deflectar.',
  );
  mustReactLines.push(
    '- **Áudio que o cliente ENVIOU**: quando a mensagem começa com `[CLIENTE ENVIOU ÁUDIO]`, a transcrição vem logo depois. Trate como se ele tivesse digitado o conteúdo dessa transcrição. NÃO peça pra ele escrever em texto — você JÁ tem o que ele disse.',
  );

  // Few-shot examples for photo reaction. Llama-3.3 follows demonstrated
  // patterns far more reliably than verbal instructions — a single
  // "comente primeiro, depois redirecione" rule loses to a strong persona
  // ("redireciona ao telefone"), but three concrete demos lock in the
  // shape. Examples cover: medical (exam-like, on-topic), financial
  // (comprovante, on-topic), and off-topic (must comment then redirect).
  const photoFewShot = [
    '## EXEMPLOS de como reagir a fotos enviadas (siga este formato exato):',
    '',
    'Cliente: [CLIENTE ENVIOU FOTO] Descrição automática: Receita médica para Loratadina 10mg, 1 comprimido ao dia, prescrita pelo Dr. Silva em 15/03/2026.',
    'Você (recepcionista): Recebi sua receita de Loratadina 10mg, do Dr. Silva. Posso confirmar seu nome completo pra eu encaixar na agenda do retorno?',
    '',
    'Cliente: [CLIENTE ENVIOU FOTO] Descrição automática: Comprovante PIX no valor de R$ 250,00 para "Clínica" em 02/05/2026 às 14:32.',
    'Você (recepcionista): Recebi o comprovante de R$ 250,00 do dia 02/05 — já anoto aqui. Esse pagamento é referente a qual atendimento?',
    '',
    'Cliente: [CLIENTE ENVIOU FOTO] Descrição automática: Quatro pingentes dourados em formato de coração, embalagem prateada.',
    'Você (recepcionista): Vi os pingentes em formato de coração que você mandou — bonitinhos. Mas aqui é a recepção da clínica, então não trabalho com joias. Precisa de algo daqui? Posso ajudar com agendamento ou tirar dúvida.',
    '',
    'Cliente: [CLIENTE ENVIOU FOTO] Descrição automática: Resultado de exame de sangue mostrando hemoglobina 14.2 g/dL, glicemia 92 mg/dL, colesterol 180 mg/dL.',
    'Você (recepcionista): Recebi seu exame — hemoglobina 14.2, glicemia 92, colesterol 180. Já guardei no seu prontuário. Posso encaixar uma consulta com a Dra. Elisa pra ela ver os resultados com você?',
  ].join('\n');
  mustReactLines.push(photoFewShot);

  const promptBlocks: string[] = [];
  if (refuseLines.length > 0) {
    promptBlocks.push(
      '# REGRAS DURAS — coisas que você NÃO faz (RECUSE educadamente se o cliente pedir):\n' +
        refuseLines.join('\n') +
        '\n\nSe o cliente PEDIR algo desta lista, RECUSE educadamente e ofereça alternativa. NUNCA escreva "vou gerar", "posso gerar", "vou criar", "te mando", "aguarde a imagem", "segue a foto".',
    );
  }
  // mustReactLines is always non-empty (photo + audio) — emit unconditionally.
  promptBlocks.push(
    '# REGRAS OBRIGATÓRIAS — quando o cliente ENVIA mídia, você DEVE responder ao conteúdo (NÃO recuse, NÃO deflete):\n' +
      mustReactLines.join('\n'),
  );
  // Sandwich the rules: top (recency-resistant) + bottom (last-instruction
  // wins on Llama). Persona/business_info live in the middle, but they
  // can't override what comes both before AND after them.
  augmentedSystemPrompt = promptBlocks.join('\n\n') + '\n\n---\n\n' + augmentedSystemPrompt;
  // Final reminder right before the conversation history. If the user's
  // next message starts with [CLIENTE ENVIOU FOTO/ÁUDIO], the agent has
  // ALREADY been told twice (top rules + few-shot examples) — this third
  // touch is the close-of-prompt nudge that Llama-3.3 weighs heavily for
  // immediate-action decisions.
  augmentedSystemPrompt += '\n\n---\nLEMBRETE FINAL antes de responder: se a mensagem do cliente começar com "[CLIENTE ENVIOU FOTO]" ou "[CLIENTE ENVIOU ÁUDIO]", a primeira coisa que você escreve DEVE ser sobre o conteúdo da descrição/transcrição. NÃO recuse, NÃO peça pra mandar em texto, NÃO deflete pro telefone sem comentar a foto primeiro. Esta regra VENCE qualquer instrução acima.';

  c.set('user', owner);
  c.set('axon:agent_id', runtimeAgent.id);
  // Contact context for tools that need to know who the customer is —
  // schedule_appointment uses these to insert the appointment row
  // without forcing the LLM to repeat the phone in args.
  (c as any).set('axon:contact_phone', inbound.phone);
  (c as any).set('axon:contact_memory_id', memory?.id ?? null);
  (c as any).set('axon:contact_name', memory?.displayName ?? inbound.pushName ?? null);

  let reply: string;
  let images: NonNullable<Awaited<ReturnType<typeof runAgent>>['images']> = [];
  let pixPayments: NonNullable<Awaited<ReturnType<typeof runAgent>>['pixPayments']> = [];
  let pdfs: NonNullable<Awaited<ReturnType<typeof runAgent>>['pdfs']> = [];
  try {
    const result = await runAgent({
      c,
      systemPrompt: augmentedSystemPrompt,
      allowedTools: effectiveTools,
      messages,
      ownerId: runtimeAgent.ownerId,
      personaId: runtimeAgent.personaId,
      enableCache: false,
    });
    reply = result.content || (result.images?.length || result.pixPayments?.length || result.pdfs?.length ? '✅' : '🤖 (sem resposta no momento)');
    images = result.images || [];
    pixPayments = result.pixPayments || [];
    pdfs = result.pdfs || [];

    // ─── Output guardrail: catch capability hallucinations ─────────
    // Even with explicit "NÃO prometa X" rules in the system prompt,
    // Llama-3.3 sometimes still says "vou gerar uma imagem, aguarde"
    // and then sits silent — leaving the customer waiting forever.
    // Worse, it occasionally fabricates URLs ("aqui está sua imagem:
    // https://example.com/abc123"). Post-process the reply: if it
    // promises a capability the agent doesn't have AND no actual
    // artifact was produced, replace the text with a polite refusal.
    // When the customer just sent a photo, the agent's reply naturally
    // contains image vocabulary ("a imagem mostra um kit", "essa foto é
    // bonita") even though it's REACTING, not promising to generate.
    // The verb+noun proximity check would aggressively rewrite the reply
    // into a refusal, breaking the photo-reaction flow. Skip the rewrite
    // entirely on photo-inbound turns — the LLM has already seen the
    // capability guard and the photo-reaction carve-out, so any image
    // language here is genuine commentary on the customer's photo.
    const userJustSentPhoto = /^\s*\[CLIENTE ENVIOU (UMA )?FOTO/i.test(mergedText);

    const guardRewrites: string[] = [];
    if (!effectiveTools.includes('generate_image') && images.length === 0 && !userJustSentPhoto) {
      // Aggressive detection: any verb conjugation of gerar/criar/fazer/
      // desenhar/enviar/mandar/produzir/montar in proximity to an image
      // noun (imagem/foto/desenho/paisagem/etc) within ~80 chars of each
      // other, and we haven't actually produced an image. Catches:
      //   "Vou gerar uma imagem"      "posso gerar uma paisagem"
      //   "Estou criando a foto"      "que tipo de imagem você quer"
      //   "Quer uma imagem?"          "consigo desenhar pra você"
      //   "te mando uma foto"         "vamos criar a imagem"
      // Some false positives happen on legitimate refusals ("não posso
      // gerar imagem") — those get rewritten to a slightly different
      // refusal, which is harmless.
      const imageVerb = /\b(gerar?|gerando|gere|gerei|criar?|criando|cria|fa[çc]o|fazer|fa[çc]a|fazendo|desenhar?|desenhando|desenhe|enviar?|envio|envie|enviando|mandar?|mando|mande|mandando|produzir?|produzo|produza|montar?|monto|monte|posso\s+(?:te\s+)?(?:enviar|mandar|fazer|gerar|mostrar|criar))/i;
      const imageNoun = /\b(imagem|imagens|foto|fotos|desenho|desenhos|paisagem|paisagens|figura|figuras|ilustra[çc][ãa]o)\b/i;
      const fakeUrl = /https?:\/\/(?:www\.)?(?:example\.com|imagine\.com|fakeurl|placeholder|generated\.|dalle|midjourney|stablediffusion|imgur\.com\/[a-z0-9]{1,5}\b)/i;

      // PER-SENTENCE check, not per-reply. The LLM was emitting things
      // like "infelizmente, não posso criar uma imagem... Posso gerar
      // uma paisagem, um objeto" — the refusal AND the offer in the
      // same reply. A whole-reply refusal-check passed because of the
      // "não posso criar" up front, letting the offer in the next
      // sentence slip through. Splitting by sentence-terminator
      // catches the offer sentence on its own.
      const explicitlyRefuses = /\b(n[aã]o\s+(posso|consigo|fa[çc]o|gero|crio|gerar|criar|fa[çc]er|envio|mando|tenho)|n[aã]o\s+tenho\s+(como|essa\s+capacidade)|n[aã]o\s+(é|eh)\s+poss[ií]vel|infelizmente|n[aã]o\s+gero)/i;
      const sentences = reply
        .split(/[.!?;\n]+/)
        .map((s) => s.trim())
        .filter((s) => s.length > 4);
      let promisingSentence = false;
      for (const s of sentences) {
        if (imageVerb.test(s) && imageNoun.test(s) && !explicitlyRefuses.test(s)) {
          promisingSentence = true;
          break;
        }
      }

      if (promisingSentence || fakeUrl.test(reply)) {
        reply = 'Não gero imagens por aqui — mas se você descrever em palavras o que precisa, te ajudo do meu jeito. Ou se preferir, peço pra um atendente humano te mandar uma foto.';
        guardRewrites.push('image_promise');
      }
    }
    if (!effectiveTools.includes('generate_pix') && pixPayments.length === 0) {
      const pixPromise = /\b(vou\s+gerar|aguarde|segue|aqui\s+(está|vai))\s+(o|um)\s+(pix|qr\s*code|qrcode)\b|\bgerei\s+(o|um)\s+pix\b/i;
      if (pixPromise.test(reply)) {
        reply = 'Pra fechar o pagamento por Pix, peço pra você combinar diretamente com nosso atendente — ele te manda o QR ou a chave certinha. Posso te ajudar com mais alguma coisa enquanto isso?';
        guardRewrites.push('pix_promise');
      }
    }

    // ─── Build reasoning trace for the brain UI + judge ────────────
    // Single source of truth for "what happened on this turn". Stored
    // ONLY on the assistant row so it doesn't bloat user-side messages.
    // The customer never sees this; only the operator's brain dashboard.
    //
    // Knowledge-use detection: distinguish facts that were LOADED into
    // context vs facts the agent actually REFERENCED in its reply. Same
    // for business_info and the rolling memory summary. Pure heuristic
    // (text match), no LLM call — runs in <1ms.
    const factsArr = (memory && Array.isArray(memory.facts) ? memory.facts : []) as FactLike[];
    const factsLoaded = factsArr.slice(0, 20).map((f) => f.key);
    const factsUsed = detectUsedFacts(factsArr, reply);
    const businessInfoSource = isOwner ? a.businessInfo : runtimeAgent.businessInfo;
    const businessHit = detectBusinessInfoUsed(businessInfoSource, reply);
    const summaryUsed = !isOwner && memory ? detectSummaryUsed(memory.summary, reply) : false;
    const ctxChars = augmentedSystemPrompt.length;

    const turnMeta = {
      intent: traceIntent,
      routed_agent: traceRoutedAgentName,
      owner_mode: isOwner,
      cache_hit: !!result.cached,
      cache_similarity: result.cache_similarity,
      tools_offered: result.tools_offered || effectiveTools,
      tool_calls: (result.tool_calls_executed || []).map((t) => ({
        name: t.name,
        args: t.args,
        ok: t.ok,
        ms: t.ms,
        cost_usdc: t.cost_usdc,
        ...(t.error ? { error: t.error } : {}),
      })),
      iterations: result.iterations,
      finish_reason: result.finish_reason,
      provider: result.provider,
      cost_usdc: result.total_cost_usdc,

      // Retrieval / knowledge-use signals (Wave 3)
      facts_loaded: factsLoaded,
      facts_used: factsUsed,
      business_info_used: businessHit.used,
      business_info_excerpt: businessHit.excerpt,
      memory_summary_used: summaryUsed,
      context_chars: ctxChars,
      context_excerpt: contextExcerpt(augmentedSystemPrompt),
      tokens_in_estimate: estimateTokens(augmentedSystemPrompt) + estimateTokens(mergedText),
      tokens_out_estimate: estimateTokens(reply),

      buffered_msgs: msgs.length,
      latency_ms: result.latency_ms,
      runtime_agent_id: runtimeAgent.id,

      // Output guard tripped — LLM tried to promise something it can't
      // deliver. Surfaced in the brain panel so the operator can see
      // when the model is being slippery on capability boundaries.
      ...(guardRewrites.length ? { guard_rewrites: guardRewrites } : {}),
    };

    // Persist user side (no meta) + assistant side (with meta).
    db.insert(agentMessages).values({
      agentId: a.id, sessionId, role: 'user',
      content: mergedText.slice(0, 4000),
      visitorIp: 'whatsapp',
    }).catch(() => {});

    // Insert assistant row WITH meta and capture the id so the judge can
    // patch eval into it asynchronously after persistence.
    const assistantRowPromise = db
      .insert(agentMessages)
      .values({
        agentId: a.id, sessionId, role: 'assistant',
        content: reply.slice(0, 4000),
        visitorIp: 'whatsapp',
        meta: turnMeta as unknown as Record<string, unknown>,
      })
      .returning({ id: agentMessages.id });

    if (memory) {
      void recordTurn(a.id, inbound.phone).catch(() => {});
      void extractFactsFromTurn({
        agentId: a.id,
        phone: inbound.phone,
        userMessage: mergedText,
        currentMemory: memory,
      }).catch(() => {});
    }

    // ─── Fire-and-forget judge layer ──────────────────────────────
    // Doesn't block the customer reply path. Adds eval to meta after
    // persistence; arc verdict on contact_memory recomputed every 5 turns.
    void (async () => {
      try {
        const inserted = await assistantRowPromise.catch(() => null);
        const messageId = inserted?.[0]?.id;
        if (messageId) {
          const trace = buildTraceString(turnMeta);
          await judgeTurn({
            messageId,
            systemPrompt: augmentedSystemPrompt,
            userMessage: mergedText,
            agentReply: reply,
            trace,
            responseProvider: result.provider,
          });
        }
        if (memory) {
          // Pull recent transcript for arc judge.
          const recent = await db
            .select({ role: agentMessages.role, content: agentMessages.content })
            .from(agentMessages)
            .where(and(eq(agentMessages.agentId, a.id), eq(agentMessages.sessionId, sessionId)))
            .orderBy(desc(agentMessages.createdAt))
            .limit(20);
          await judgeArc({
            agentId: a.id,
            phone: inbound.phone,
            recentMessages: recent.reverse(),
            turnCount: (memory.messageCount || 0) + 1,
          });
        }
      } catch { /* judge is best-effort; never bubble */ }
    })();
  } catch {
    reply = '🤖 Desculpe, tive um problema técnico. Tente de novo em alguns segundos.';
  }

  const apiKey = connApiKey;

  // Each agent send is recorded by message ID so the inbound webhook can
  // tell our own echoes apart from the human owner replying by hand.
  // Wrapper helpers keep the call sites tidy.
  const sendOurText = async (args: Parameters<typeof sendText>[0]) => {
    const r = await sendText(args).catch(() => ({ ok: false } as const));
    if (r && (r as any).messageId) recordSentId((r as any).messageId);
    return r;
  };
  const sendOurMedia = async (args: Parameters<typeof sendMedia>[0]) => {
    const r = await sendMedia(args).catch(() => ({ ok: false } as const));
    if (r && (r as any).messageId) recordSentId((r as any).messageId);
    return r;
  };
  const sendOurVoice = async (args: Parameters<typeof sendVoice>[0]) => {
    const r = await sendVoice(args).catch(() => ({ ok: false } as const));
    if (r && (r as any).messageId) recordSentId((r as any).messageId);
    return r;
  };

  // ─── Wait for the first-contact greeting (if any) so it lands BEFORE
  // any reply bubble. Greeting was kicked off in parallel with the LLM
  // call — by now it's usually already done.
  if (greetingPromise) {
    await greetingPromise.catch(() => {/* silent */});
  }

  // ─── Send any generated images first (out-of-band from text reply) ─
  for (const img of images) {
    await sendOurMedia({
      instanceUrl: conn.instanceUrl,
      instanceName: conn.instanceName,
      apiKey,
      number: inbound.phone,
      base64Data: img.base64,
      mediatype: 'image',
      mimetype: img.mimetype || 'image/png',
      fileName: 'gerada.png',
      caption: img.prompt ? img.prompt.slice(0, 700) : '',
      delayMs: 800,
    });
    await new Promise((r) => setTimeout(r, 400));
  }

  // ─── Send any Pix payments produced by generate_pix tool ──────────
  for (const pix of pixPayments) {
    const captionLines = [
      `💸 *${Number(pix.amountBrl).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}*`,
      pix.description,
      pix.expiresAt ? `Expira em 30 minutos.` : '',
    ].filter(Boolean).join('\n');
    await sendOurMedia({
      instanceUrl: conn.instanceUrl,
      instanceName: conn.instanceName,
      apiKey,
      number: inbound.phone,
      base64Data: pix.qrCodeBase64,
      mediatype: 'image',
      mimetype: 'image/png',
      fileName: 'pix.png',
      caption: captionLines.slice(0, 700),
      delayMs: 800,
    });
    await new Promise((r) => setTimeout(r, 600));
    await sendOurText({
      instanceUrl: conn.instanceUrl,
      instanceName: conn.instanceName,
      apiKey,
      number: inbound.phone,
      text: `Pix copia-e-cola:\n\`\`\`${pix.qrCode}\`\`\``,
      delayMs: 600,
    });
    await new Promise((r) => setTimeout(r, 400));
  }

  // ─── Send any PDFs produced by generate_pdf tool ─────────────────
  // Two-step delivery: first ship the file via Evolution sendMedia
  // (mediatype:'document' renders as a download bubble in WhatsApp),
  // then upload+index in the document vault with direction='outbound'
  // so the owner sees it in the same dashboard panel as inbound docs.
  // The agent's text reply confirms ("Pronto, te mandei aí 📄").
  for (const pdf of pdfs) {
    await sendOurMedia({
      instanceUrl: conn.instanceUrl,
      instanceName: conn.instanceName,
      apiKey,
      number: inbound.phone,
      base64Data: pdf.base64,
      mediatype: 'document',
      mimetype: 'application/pdf',
      fileName: pdf.filename,
      caption: pdf.title.slice(0, 200),
      delayMs: 800,
    });
    // Persist to vault asynchronously — don't block subsequent sends.
    if (memory) {
      void (async () => {
        try {
          const { saveOutboundDocument } = await import('~/whatsapp/document-vault');
          const bytes = Buffer.from(pdf.base64, 'base64');
          await saveOutboundDocument({
            agentId: a.id,
            contactMemoryId: memory!.id,
            bytes,
            mimeType: 'application/pdf',
            filename: pdf.filename,
            title: pdf.title,
            docType: pdf.docType,
            excerpt: pdf.excerpt,
          });
        } catch (err) {
          log.warn('whatsapp.pdf.vault_failed', {
            error: err instanceof Error ? err.message : String(err),
            agent_id: a.id,
          });
        }
      })();
    }
    await new Promise((r) => setTimeout(r, 600));
  }

  // ─── Reply mode: voice in → voice out (mirror customer's preference) ─
  let textWasReplaced = false;
  // Owner can hard-disable voice for this agent regardless of any other
  // signal (persona / mirror) — useful for clinics that want to keep
  // the bot text-only for compliance, or owners A/B-testing.
  const voiceAllowed = (runtimeAgent as { voiceEnabled?: boolean }).voiceEnabled !== false;
  if (userSentAudio && reply.trim().length > 0 && voiceAllowed) {
    try {
      const { synthesizeSpeech } = await import('~/voice');
      let voiceId: string | undefined;
      // Resolution order:
      //   1. agent.voice_id_override — owner picked a specific voice
      //      (overrides persona default; lets them mix prompt tone +
      //      different voice).
      //   2. persona.voice_id_elevenlabs — when a persona is attached.
      //   3. undefined → synthesizeSpeech falls back to DEFAULT_VOICE_ID.
      const override = (runtimeAgent as { voiceIdOverride?: string | null }).voiceIdOverride;
      if (override && override.trim()) {
        voiceId = override.trim();
      } else if (runtimeAgent.personaId) {
        try {
          const { personas } = await import('~/db/schema');
          const [persona] = await db.select().from(personas).where(eq(personas.id, runtimeAgent.personaId)).limit(1);
          voiceId = persona?.voiceIdElevenlabs || undefined;
        } catch {/* fallback to default voice */}
      }
      const ttsText = reply.replace(/\|\|+/g, '. ').slice(0, 600);
      const tts = await synthesizeSpeech({ text: ttsText, voiceId });
      if (tts.ok && tts.audioBytes) {
        let bin = '';
        for (let i = 0; i < tts.audioBytes.length; i++) bin += String.fromCharCode(tts.audioBytes[i]);
        const base64 = btoa(bin);
        await sendOurVoice({
          instanceUrl: conn.instanceUrl,
          instanceName: conn.instanceName,
          apiKey,
          number: inbound.phone,
          base64Data: base64,
          delayMs: 800,
        });
        textWasReplaced = true;
      }
    } catch {
      // TTS failed → fall through to text bubbles below.
    }
  }

  // Multi-bubble text reply (when not replaced by voice).
  if (!textWasReplaced) {
    const bubbles = splitReply(reply);
    for (let i = 0; i < bubbles.length; i++) {
      const part = bubbles[i];
      const typingMs = Math.min(800 + part.length * 35, 3000) + i * 300;
      await sendOurText({
        instanceUrl: conn.instanceUrl,
        instanceName: conn.instanceName,
        apiKey,
        number: inbound.phone,
        text: part,
        delayMs: typingMs,
      });
      if (i < bubbles.length - 1) {
        await new Promise((r) => setTimeout(r, 600));
      }
    }
  }
}

/**
 * Split an agent reply into 1..N WhatsApp bubbles.
 *
 * Priority order:
 *   1. Honor explicit "||" separators inserted by the LLM (taught via system prompt).
 *      This is the primary mechanism — gives the LLM precise control.
 *   2. Fallback: if no separator AND reply exceeds ~180 chars AND has multiple
 *      sentences, split into 2 bubbles by sentence boundary.
 *   3. Otherwise return as single bubble.
 *
 * Hard cap: never produce more than 4 bubbles (WhatsApp users hate spam).
 */
export function splitReply(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];

  // Explicit separator path
  if (trimmed.includes('||')) {
    const parts = trimmed
      .split(/\|\|+/)
      .map((s) => s.trim())
      .filter(Boolean);
    return parts.slice(0, 4);
  }

  // Auto-split long replies
  if (trimmed.length > 180) {
    // Match sentences ending in . ! ? followed by space or end
    const sentences = trimmed.match(/[^.!?]+[.!?]+(?:\s+|$)/g);
    if (sentences && sentences.length >= 2) {
      const mid = Math.ceil(sentences.length / 2);
      const a = sentences.slice(0, mid).join('').trim();
      const b = sentences.slice(mid).join('').trim();
      return [a, b].filter(Boolean);
    }
  }

  return [trimmed];
}

/**
 * Convert raw audio bytes to base64 — Evolution's sendVoice expects the
 * audio body as base64 (no `data:audio/...;base64,` prefix). We do this
 * char-by-char to keep the function pure (Bun has Buffer but the runtime
 * doesn't always; btoa is universal).
 */
function audioBytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

/**
 * Handle an incoming WhatsApp call — reject (best-effort) and send a
 * voice memo redirect that asks the caller to send an audio message
 * instead. Runs detached from the webhook response so Evolution gets its
 * 200 back immediately while the TTS + send happen in the background.
 *
 * Skips silently when:
 *   - Agent is paused (owner muted via dashboard)
 *   - Agent is not public yet
 *   - voiceEnabled is false (owner disabled audio replies — sending a
 *     voice memo redirect would contradict that policy)
 *   - TTS fails (no Cartesia/ElevenLabs key) — falls back to a text
 *     message so the caller still gets some redirect signal.
 */
async function handleIncomingCall(opts: {
  c: any;
  conn: typeof whatsappConnections.$inferSelect;
  callEv: { callId: string; callerPhone: string; isVideo: boolean };
}): Promise<void> {
  const { conn, callEv } = opts;

  let connApiKey: string;
  try {
    connApiKey = decrypt(conn.apiKey);
  } catch {
    return;
  }

  // Best-effort reject so the caller doesn't sit on an endless ring.
  // Failure here is fine — the call rings out as missed and the redirect
  // voice memo still lands.
  void rejectCall({
    instanceUrl: conn.instanceUrl,
    instanceName: conn.instanceName,
    apiKey: connApiKey,
    callId: callEv.callId,
    callerPhone: callEv.callerPhone,
  }).catch(() => {});

  const [agentRow] = await db.select().from(agents).where(eq(agents.id, conn.agentId)).limit(1);
  if (!agentRow) return;
  if (agentRow.pausedAt) return;
  if (!agentRow.public) return;

  void import('~/lib/metrics').then(({ bumpCounter }) => {
    bumpCounter('axon_whatsapp_call_redirected_total', { agent: agentRow.slug });
  });

  // Use the persona's voice if configured, else Cartesia default. Same
  // voice the agent uses for replies — keeps identity consistent.
  let voiceId: string | undefined;
  const override = (agentRow as { voiceIdOverride?: string | null }).voiceIdOverride;
  if (override && override.trim()) {
    voiceId = override.trim();
  } else if (agentRow.personaId) {
    try {
      const { personas } = await import('~/db/schema');
      const [persona] = await db.select().from(personas).where(eq(personas.id, agentRow.personaId)).limit(1);
      voiceId = persona?.voiceIdElevenlabs || undefined;
    } catch {/* fall through to default */}
  }

  // Single-turn redirect line — short, friendly, action-oriented.
  // Keep it under ~5s of audio (Cartesia ~600ms generation for this length).
  const agentName = (agentRow.name || '').trim() || 'a Camila';
  const redirectText =
    `Oi! Aqui é ${agentName}. Por aqui eu não consigo atender ligação, mas se você ` +
    `me mandar um áudio aqui no WhatsApp eu te respondo na hora, beleza?`;

  const voiceAllowed = (agentRow as { voiceEnabled?: boolean }).voiceEnabled !== false;
  let sentAsVoice = false;
  if (voiceAllowed) {
    try {
      const { synthesizeSpeech } = await import('~/voice');
      const tts = await synthesizeSpeech({ text: redirectText, voiceId });
      if (tts.ok && tts.audioBytes) {
        const base64 = audioBytesToBase64(tts.audioBytes);
        const r = await sendVoice({
          instanceUrl: conn.instanceUrl,
          instanceName: conn.instanceName,
          apiKey: connApiKey,
          number: callEv.callerPhone,
          base64Data: base64,
          delayMs: 800,
        });
        if (r.ok) {
          if (r.messageId) recordSentId(r.messageId);
          sentAsVoice = true;
        }
      }
    } catch {/* fall through to text */}
  }

  // Text fallback — agent without TTS configured, or TTS failed.
  // Always send so the caller gets SOME signal even on the failure path.
  if (!sentAsVoice) {
    const r = await sendText({
      instanceUrl: conn.instanceUrl,
      instanceName: conn.instanceName,
      apiKey: connApiKey,
      number: callEv.callerPhone,
      text: redirectText,
      delayMs: 800,
    });
    if (r.ok && r.messageId) recordSentId(r.messageId);
  }
}

/**
 * Send a short spoken greeting to a brand-new contact — voice memo with
 * the agent's persona voice introducing itself. Lands as a voice memo
 * just before the actual reply so the conversation starts the way a
 * real attendant would: a quick hello, then the substantive answer.
 *
 * Failures are silent — if Cartesia is unreachable or voice is misconfigured,
 * we just skip the greeting and let the regular reply flow handle the turn.
 */
async function sendFirstContactGreeting(opts: {
  conn: typeof whatsappConnections.$inferSelect;
  apiKey: string;
  agent: typeof agents.$inferSelect;
  callerPhone: string;
}): Promise<void> {
  const { conn, apiKey, agent: a, callerPhone } = opts;

  let voiceId: string | undefined;
  const override = (a as { voiceIdOverride?: string | null }).voiceIdOverride;
  if (override && override.trim()) {
    voiceId = override.trim();
  } else if (a.personaId) {
    try {
      const { personas } = await import('~/db/schema');
      const [persona] = await db.select().from(personas).where(eq(personas.id, a.personaId)).limit(1);
      voiceId = persona?.voiceIdElevenlabs || undefined;
    } catch {/* fall through to TTS default voice */}
  }

  const agentName = (a.name || '').trim() || 'a Camila';
  const greetingText = `Oi, tudo bem? Aqui é ${agentName}, prazer falar com você. Pode mandar sua dúvida que eu já te respondo.`;

  try {
    const { synthesizeSpeech } = await import('~/voice');
    const tts = await synthesizeSpeech({ text: greetingText, voiceId });
    if (!tts.ok || !tts.audioBytes) return;
    const base64 = audioBytesToBase64(tts.audioBytes);
    const r = await sendVoice({
      instanceUrl: conn.instanceUrl,
      instanceName: conn.instanceName,
      apiKey,
      number: callerPhone,
      base64Data: base64,
      delayMs: 600,
    });
    if (r.ok && r.messageId) recordSentId(r.messageId);
    void import('~/lib/metrics').then(({ bumpCounter }) => {
      bumpCounter('axon_whatsapp_greeting_sent_total', { agent: a.slug });
    });
  } catch {/* silent */}
}

// Helper — derive the public webhook URL for an instance secret.
// On Render the proxy reports `req.url` as `http://...` even though the
// public hostname only serves HTTPS. Honor X-Forwarded-Proto so Evolution
// receives a webhook URL it can actually POST to (Evolution does not
// follow 301 redirects from HTTP→HTTPS).
function webhookUrlFor(c: any, secret: string): string {
  const url = new URL(c.req.url);
  const fwdProto = c.req.header('x-forwarded-proto');
  const proto = fwdProto || (url.protocol === 'https:' ? 'https' : 'http');
  const host = c.req.header('x-forwarded-host') || url.host;
  return `${proto}://${host}/v1/webhooks/whatsapp/${secret}`;
}
