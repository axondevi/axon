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
import { checkInstance, setWebhook, sendText, extractInbound } from '~/whatsapp/evolution';
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

  // 3. Register Axon's webhook on the Evolution instance
  const set = await setWebhook({ instanceUrl, instanceName, apiKey, webhookUrl });
  if (!set.ok) {
    // Roll back the row so the owner sees the error and can fix
    await db.delete(whatsappConnections).where(eq(whatsappConnections.webhookSecret, secret));
    return c.json({ error: 'webhook_register_failed', message: set.error || 'Could not register webhook' }, 502);
  }

  return c.json({
    ok: true,
    connection: {
      instance_url: instanceUrl,
      instance_name: instanceName,
      status: probe.status || 'connected',
      webhook_url: webhookUrl,
    },
  });
});

// DELETE disconnect
ownerWhatsapp.delete('/:id/whatsapp', async (c) => {
  const user = c.get('user') as { id: string };
  const agentId = c.req.param('id');
  const [a] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.ownerId, user.id)));
  if (!a) throw Errors.notFound('Agent');

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

  // Resolve agent + owner
  const [a] = await db.select().from(agents).where(eq(agents.id, conn.agentId)).limit(1);
  if (!a || !a.public) return c.json({ ignored: 'agent_inactive' });
  const [owner] = await db.select().from(users).where(eq(users.id, conn.ownerId)).limit(1);
  if (!owner) return c.json({ ignored: 'owner_missing' });

  // Build conversation history from agent_messages keyed by this phone
  const sessionId = `wa:${inbound.phone}`;
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

  const messages: ChatMessage[] = [...priorMessages, { role: 'user', content: inbound.text }];

  // ─── Contact memory: load before generation ─────────────────
  // Lazy-create the contact_memory row on first contact. Inject what we
  // know (name/language/facts/history) into the system prompt so the agent
  // recognizes the person across sessions and personalizes its reply.
  const memory = await getOrCreateMemory(a.id, inbound.phone, inbound.pushName).catch(() => null);
  const memoryContext = memory ? buildMemoryContext(memory) : '';
  const augmentedSystemPrompt = memoryContext
    ? `${a.systemPrompt}\n\n## O que você sabe sobre este contato\n${memoryContext}`
    : a.systemPrompt;

  // Run the agent (synchronously — Evolution waits up to ~30s)
  c.set('user', owner);
  c.set('axon:agent_id', a.id);

  let reply: string;
  try {
    const result = await runAgent({
      c,
      systemPrompt: augmentedSystemPrompt,
      allowedTools: Array.isArray(a.allowedTools) ? (a.allowedTools as string[]) : [],
      messages,
      ownerId: a.ownerId,
      // Disable semantic cache: each contact's context is unique. The same
      // question from Pedro (VIP) vs Maria (new) warrants different replies.
      enableCache: false,
    });
    reply = result.content || '🤖 (sem resposta no momento)';

    // Persist both sides of the turn
    db.insert(agentMessages).values({
      agentId: a.id, sessionId, role: 'user',
      content: inbound.text.slice(0, 4000),
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
        userMessage: inbound.text,
        currentMemory: memory,
      }).catch(() => {});
    }
  } catch (err: any) {
    reply = '🤖 Desculpe, tive um problema técnico. Tente de novo em alguns segundos.';
  }

  // Send the reply back via Evolution
  let apiKey: string;
  try {
    apiKey = decrypt(conn.apiKey);
  } catch {
    return c.json({ ignored: 'cannot_decrypt_key' });
  }
  await sendText({
    instanceUrl: conn.instanceUrl,
    instanceName: conn.instanceName,
    apiKey,
    number: inbound.phone,
    text: reply,
  });

  return c.json({ ok: true });
});

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
