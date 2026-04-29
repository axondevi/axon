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

// ─── Owner-authed sub-router (mounted under /v1/agents) ────
export const ownerWhatsapp = new Hono();

// GET current connection
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

  return c.json({
    connected: true,
    instance_url: conn.instanceUrl,
    instance_name: conn.instanceName,
    status: conn.status,
    last_event_at: conn.lastEventAt,
    webhook_url: webhookUrlFor(c, conn.webhookSecret),
    owner_phone: a.ownerPhone || null,
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

  // Resolve agent + owner
  const [a] = await db.select().from(agents).where(eq(agents.id, conn.agentId)).limit(1);
  if (!a || !a.public) return c.json({ ignored: 'agent_inactive' });
  const [owner] = await db.select().from(users).where(eq(users.id, conn.ownerId)).limit(1);
  if (!owner) return c.json({ ignored: 'owner_missing' });

  // ─── Owner-mode detection ─────────────────────────────────
  // If the inbound phone matches the agent's registered owner_phone, the
  // agent flips from "public persona" (Camila answering customers) to a
  // "personal assistant" mode for the owner: different system prompt,
  // unconditional access to power tools (image gen, web search, scrape).
  // Match is digits-only to be tolerant of formatting differences.
  const inboundDigits = inbound.phone.replace(/\D/g, '');
  const ownerDigits = (a.ownerPhone || '').replace(/\D/g, '');
  const isOwner = ownerDigits.length > 0 && inboundDigits === ownerDigits;

  // Build conversation history from agent_messages keyed by this phone.
  // Owner conversations get a separate session bucket so the personal-assistant
  // history doesn't leak into customer-facing turns (and vice-versa).
  const sessionId = isOwner ? `wa-owner:${inbound.phone}` : `wa:${inbound.phone}`;
  const history = await db
    .select()
    .from(agentMessages)
    .where(and(eq(agentMessages.agentId, a.id), eq(agentMessages.sessionId, sessionId)))
    .orderBy(desc(agentMessages.createdAt))
    .limit(20);
  // Reverse to chronological + filter to user/assistant
  const priorMessages: ChatMessage[] = history
    .reverse()
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));

  const messages: ChatMessage[] = [...priorMessages, { role: 'user', content: inboundText }];

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
    // ─── Contact memory: load before generation ─────────────────
    // Lazy-create the contact_memory row on first contact. Inject what we
    // know (name/language/facts/history) into the system prompt so the agent
    // recognizes the person across sessions and personalizes its reply.
    memory = await getOrCreateMemory(a.id, inbound.phone, inbound.pushName).catch(() => null);
    const memoryContext = memory ? buildMemoryContext(memory) : '';
    augmentedSystemPrompt = memoryContext
      ? `${a.systemPrompt}\n\n## O que você sabe sobre este contato\n${memoryContext}`
      : a.systemPrompt;
  }

  // Owner gets a superset of tools (image gen + research stack) regardless
  // of the agent's configured allowedTools — those are for the public persona.
  const baseTools = Array.isArray(a.allowedTools) ? (a.allowedTools as string[]) : [];
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

  // Run the agent (synchronously — Evolution waits up to ~30s)
  c.set('user', owner);
  c.set('axon:agent_id', a.id);

  let reply: string;
  let images: NonNullable<Awaited<ReturnType<typeof runAgent>>['images']> = [];
  let pixPayments: NonNullable<Awaited<ReturnType<typeof runAgent>>['pixPayments']> = [];
  try {
    const result = await runAgent({
      c,
      systemPrompt: augmentedSystemPrompt,
      allowedTools: effectiveTools,
      messages,
      ownerId: a.ownerId,
      // Disable semantic cache: each contact's context is unique. The same
      // question from Pedro (VIP) vs Maria (new) warrants different replies.
      // Owner mode is even more dynamic — never cache.
      enableCache: false,
    });
    reply = result.content || (result.images?.length || result.pixPayments?.length ? '✅' : '🤖 (sem resposta no momento)');
    images = result.images || [];
    pixPayments = result.pixPayments || [];

    // Persist both sides of the turn
    db.insert(agentMessages).values({
      agentId: a.id, sessionId, role: 'user',
      content: inboundText.slice(0, 4000),
      visitorIp: 'whatsapp',
    }).catch(() => {});
    db.insert(agentMessages).values({
      agentId: a.id, sessionId, role: 'assistant',
      content: reply.slice(0, 4000),
      visitorIp: 'whatsapp',
    }).catch(() => {});

    // ─── Memory update (fire-and-forget, no await) ───────────
    // Extract durable facts from the user's message and bump turn counter.
    // These run in background so the WhatsApp reply isn't delayed.
    if (memory) {
      void recordTurn(a.id, inbound.phone).catch(() => {});
      void extractFactsFromTurn({
        agentId: a.id,
        phone: inbound.phone,
        userMessage: inboundText,
        currentMemory: memory,
      }).catch(() => {});
    }
  } catch (err: any) {
    reply = '🤖 Desculpe, tive um problema técnico. Tente de novo em alguns segundos.';
  }

  // Reuse the API key we already decrypted at the top for media re-fetch.
  const apiKey = connApiKey;

  // ─── Send any generated images first (out-of-band from text reply) ─
  // generate_image tool returns base64 PNGs that we deliver via sendMedia,
  // independent of the text reply. The text reply is the LLM's confirmation
  // ("Pronto, mandei aí 📸") which arrives right after.
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
    // Small pause so the image lands before the text bubble
    await new Promise((r) => setTimeout(r, 400));
  }

  // ─── Send any Pix payments produced by generate_pix tool ──────────
  // Two messages per Pix: (1) the QR PNG with caption "R$X — descrição"
  // (2) the EMV copy-paste string as a plain text bubble so the user
  // can copy from any banking app on mobile (faster than scanning).
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
    // Copy-paste EMV — easiest UX on mobile (long-press to copy).
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
  // If the customer sent audio AND TTS is configured, synthesize the
  // reply and send as a voice note. Skip the multi-bubble text fallback
  // since one audio message already conveys everything (sending text
  // duplicates the content and feels robotic).
  let textWasReplaced = false;
  if (userSentAudio && reply.trim().length > 0) {
    try {
      const { synthesizeSpeech } = await import('~/voice/elevenlabs');
      // Strip || delimiters and emoji-only phrases — TTS handles plain prose best.
      const ttsText = reply.replace(/\|\|+/g, '. ').slice(0, 600);
      const tts = await synthesizeSpeech({ text: ttsText });
      if (tts.ok && tts.audioBytes) {
        // Convert to base64 for sendMedia
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

  // Multi-bubble text reply (when not replaced by voice). Humans don't dump
  // a paragraph; they send 2-3 short bursts. Agent uses "||" to mark bubble
  // breaks (taught in the system prompt); fallback splits long replies.
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

  return c.json({ ok: true });
});

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
