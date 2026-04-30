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
import { randomBytes } from 'node:crypto';
import { db } from '~/db';
import { agents, users, whatsappConnections, agentMessages } from '~/db/schema';
import { Errors } from '~/lib/errors';
import { encrypt, decrypt } from '~/lib/crypto';
import { checkInstance, setWebhook, sendText, sendMedia, connectInstance, createInstance, deleteInstance, fetchMessageMedia, extractInbound } from '~/whatsapp/evolution';
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

  // Persist status drift so subsequent GETs don't re-pay the probe cost
  // unnecessarily for already-stable states (open ↔ connected).
  const isPaired = liveState
    ? ['open', 'connected'].includes(liveState)
    : ['connected', 'open'].includes((conn.status || '').toLowerCase());
  const newStatus = isPaired ? 'connected' : (liveState || conn.status || 'connecting');
  if (liveState && newStatus !== conn.status) {
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

  // 1. Probe the instance to make sure URL+key+name actually work
  const probe = await checkInstance({ instanceUrl, instanceName, apiKey });
  if (!probe.ok) {
    return c.json({ error: 'evolution_unreachable', message: probe.error || 'unknown' }, 502);
  }

  // 2. (re)create the connection row
  const secret = randomBytes(24).toString('hex');
  const encrypted = encrypt(apiKey);
  const webhookUrl = webhookUrlFor(c, secret);

  // Replace any existing connection for this agent (one-per-agent invariant)
  await db.delete(whatsappConnections).where(eq(whatsappConnections.agentId, agentId));
  await db.insert(whatsappConnections).values({
    agentId,
    ownerId: user.id,
    instanceUrl,
    instanceName,
    apiKey: encrypted,
    webhookSecret: secret,
    status: 'connected',
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
  const encrypted = encrypt(created.apiKey);
  await db.delete(whatsappConnections).where(eq(whatsappConnections.agentId, agentId));
  await db.insert(whatsappConnections).values({
    agentId,
    ownerId: user.id,
    instanceUrl: sharedUrl,
    instanceName: created.instanceName!,
    apiKey: encrypted,
    webhookSecret: secret,
    status: 'connected',
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
  if (conn.status !== 'connected') {
    return c.json({ ignored: 'disabled' });
  }

  // Update freshness ping (sync, fire-and-forget would be fine too)
  db.update(whatsappConnections)
    .set({ lastEventAt: new Date() })
    .where(eq(whatsappConnections.id, conn.id))
    .catch(() => {});

  const payload = await c.req.json().catch(() => null);
  const inbound = extractInbound(payload);
  if (!inbound) return c.json({ ignored: 'unsupported_event' });

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
  if (inbound.kind === 'image' && inbound.messageKey && inbound.messageRaw) {
    try {
      const media = await fetchMessageMedia({
        instanceUrl: conn.instanceUrl,
        instanceName: conn.instanceName,
        apiKey: connApiKey,
        message: inbound.messageRaw,
        messageKey: inbound.messageKey,
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
        } else {
          inboundText = inbound.text ||
            '[CLIENTE ENVIOU FOTO mas não consegui processar a imagem agora — peça pra ele descrever ou tentar de novo.]';
        }
      }
    } catch {
      inboundText = inbound.text || '[CLIENTE ENVIOU FOTO — não consegui baixar.]';
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

  // Resolve agent + owner — needed to compute the session bucket BEFORE
  // we decide whether to buffer (owner conversations live in their own
  // bucket so they never get merged with a customer's burst).
  const [a] = await db.select().from(agents).where(eq(agents.id, conn.agentId)).limit(1);
  if (!a || !a.public) return c.json({ ignored: 'agent_inactive' });

  const inboundDigits = inbound.phone.replace(/\D/g, '');
  const ownerDigits = (a.ownerPhone || '').replace(/\D/g, '');
  const isOwner = ownerDigits.length > 0 && inboundDigits === ownerDigits;
  const sessionId = isOwner ? `wa-owner:${inbound.phone}` : `wa:${inbound.phone}`;

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

  // ─── System prompt assembly ────────────────────────────────
  // Owner mode: replace the public persona with a personal-assistant prompt.
  // Customer mode: keep the configured persona + inject contact memory.
  let augmentedSystemPrompt: string;
  let memory: Awaited<ReturnType<typeof getOrCreateMemory>> | null = null;
  if (isOwner) {
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
    ].join('\n');
  } else {
    // WhatsApp inbound has no URL ?ref=, so first-touch attribution can
    // only come from a different channel (web /agent/:slug?ref=...). Pass
    // null here — getOrCreateMemory keeps any earlier attribution intact.
    memory = await getOrCreateMemory(a.id, inbound.phone, inbound.pushName, null).catch(() => null);
    const memoryContext = memory ? buildMemoryContext(memory) : '';
    augmentedSystemPrompt = memoryContext
      ? `${a.systemPrompt}\n\n## O que você sabe sobre este contato\n${memoryContext}`
      : a.systemPrompt;

    // Affiliate payout (fire-and-forget). Idempotent — if already paid
    // or no referrer, this is a single SELECT and returns immediately.
    if (memory && a.affiliateEnabled && a.affiliatePayoutMicro > 0n && memory.referredByUserId && !memory.affiliatePaidAt) {
      const { payoutAffiliateIfPending } = await import('~/affiliates');
      void payoutAffiliateIfPending({ agentId: a.id, contactId: memory.id }).catch(() => {});
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
  if (!isOwner && memory && a.routesTo) {
    let routedId: string | null = null;
    let intent = (memory.routeIntent as 'sales' | 'personal' | 'support' | 'unknown' | null) || null;

    // Already routed in a previous turn → reuse without reclassifying.
    if (memory.routedAgentId) {
      routedId = memory.routedAgentId as string;
    } else {
      // First time seeing routing-enabled traffic for this contact: classify
      // and persist. classifyIntent ~300ms — kept BEFORE runAgent so the
      // specialized agent's full prompt+persona+tools all take effect on
      // this very turn (not the next one).
      intent = await classifyIntent(mergedText);
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
        runtimeAgent = routed;
        // Re-augment system prompt using the routed agent's prompt — but
        // KEEP the contact memory context block since memory is keyed on
        // the original (router) agent's id, not the routed one.
        const memoryContext = buildMemoryContext(memory);
        augmentedSystemPrompt = memoryContext
          ? `${routed.systemPrompt}\n\n## O que você sabe sobre este contato\n${memoryContext}`
          : routed.systemPrompt;
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

  c.set('user', owner);
  c.set('axon:agent_id', runtimeAgent.id);

  let reply: string;
  let images: NonNullable<Awaited<ReturnType<typeof runAgent>>['images']> = [];
  let pixPayments: NonNullable<Awaited<ReturnType<typeof runAgent>>['pixPayments']> = [];
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
    reply = result.content || (result.images?.length || result.pixPayments?.length ? '✅' : '🤖 (sem resposta no momento)');
    images = result.images || [];
    pixPayments = result.pixPayments || [];

    // Persist both sides of the turn
    db.insert(agentMessages).values({
      agentId: a.id, sessionId, role: 'user',
      content: mergedText.slice(0, 4000),
      visitorIp: 'whatsapp',
    }).catch(() => {});
    db.insert(agentMessages).values({
      agentId: a.id, sessionId, role: 'assistant',
      content: reply.slice(0, 4000),
      visitorIp: 'whatsapp',
    }).catch(() => {});

    if (memory) {
      void recordTurn(a.id, inbound.phone).catch(() => {});
      void extractFactsFromTurn({
        agentId: a.id,
        phone: inbound.phone,
        userMessage: mergedText,
        currentMemory: memory,
      }).catch(() => {});
    }
  } catch {
    reply = '🤖 Desculpe, tive um problema técnico. Tente de novo em alguns segundos.';
  }

  const apiKey = connApiKey;

  // ─── Send any generated images first (out-of-band from text reply) ─
  for (const img of images) {
    await sendMedia({
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
    }).catch(() => {});
    await new Promise((r) => setTimeout(r, 400));
  }

  // ─── Send any Pix payments produced by generate_pix tool ──────────
  for (const pix of pixPayments) {
    const captionLines = [
      `💸 *${Number(pix.amountBrl).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}*`,
      pix.description,
      pix.expiresAt ? `Expira em 30 minutos.` : '',
    ].filter(Boolean).join('\n');
    await sendMedia({
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
    }).catch(() => {});
    await new Promise((r) => setTimeout(r, 600));
    await sendText({
      instanceUrl: conn.instanceUrl,
      instanceName: conn.instanceName,
      apiKey,
      number: inbound.phone,
      text: `Pix copia-e-cola:\n\`\`\`${pix.qrCode}\`\`\``,
      delayMs: 600,
    }).catch(() => {});
    await new Promise((r) => setTimeout(r, 400));
  }

  // ─── Reply mode: voice in → voice out (mirror customer's preference) ─
  let textWasReplaced = false;
  if (userSentAudio && reply.trim().length > 0) {
    try {
      const { synthesizeSpeech } = await import('~/voice/elevenlabs');
      let voiceId: string | undefined;
      // Use the routed agent's persona when smart routing kicked in — so Tia
      // Zélia answers with the warm-elderly voice and Don Salvatore with the
      // deep Italian one, even though the customer reached out to Camila.
      if (runtimeAgent.personaId) {
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
        await sendMedia({
          instanceUrl: conn.instanceUrl,
          instanceName: conn.instanceName,
          apiKey,
          number: inbound.phone,
          base64Data: base64,
          mediatype: 'audio',
          mimetype: 'audio/mpeg',
          fileName: 'voz.mp3',
          delayMs: 800,
        }).catch(() => {});
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
      await sendText({
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
