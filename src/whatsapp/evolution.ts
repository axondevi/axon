/**
 * Evolution API client.
 *
 * Evolution is the de-facto open-source WhatsApp gateway in Brazil
 * (Baileys-based, self-hostable). The Axon owner brings their own
 * Evolution server (running on their VPS, IP, or a managed service)
 * — we just register a webhook on it and answer incoming messages.
 *
 * Endpoints we use:
 *   POST  /webhook/set/{instance}        register our webhook URL
 *   GET   /instance/connectionState/{instance}    health probe
 *   POST  /message/sendText/{instance}   reply to the user
 *
 * Auth: `apikey` header (per-instance or global, depends on the
 * customer's Evolution config — same key works for both).
 */
const FETCH_TIMEOUT_MS = 15_000;

function trimUrl(u: string): string {
  return String(u).trim().replace(/\/+$/, '');
}

async function evoFetch(
  baseUrl: string,
  path: string,
  init: RequestInit & { apiKey: string },
): Promise<Response> {
  const url = trimUrl(baseUrl) + path;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        'apikey': init.apiKey,
        'Content-Type': 'application/json',
        ...(init.headers || {}),
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

/** Verify the instance is reachable + the API key works. */
export async function checkInstance(opts: {
  instanceUrl: string;
  instanceName: string;
  apiKey: string;
}): Promise<{ ok: boolean; status?: string; error?: string }> {
  try {
    const res = await evoFetch(opts.instanceUrl, `/instance/connectionState/${encodeURIComponent(opts.instanceName)}`, {
      method: 'GET',
      apiKey: opts.apiKey,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { ok: false, error: `Evolution responded ${res.status}: ${text.slice(0, 200)}` };
    }
    const data: any = await res.json().catch(() => ({}));
    // shape: { instance: { state: 'open' | 'connecting' | 'close' } } or similar
    const state = data?.instance?.state || data?.state || 'unknown';
    return { ok: true, status: String(state) };
  } catch (err: any) {
    return { ok: false, error: err.message || String(err) };
  }
}

/** Register Axon's incoming-message webhook on the Evolution instance. */
export async function setWebhook(opts: {
  instanceUrl: string;
  instanceName: string;
  apiKey: string;
  webhookUrl: string;
}): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await evoFetch(opts.instanceUrl, `/webhook/set/${encodeURIComponent(opts.instanceName)}`, {
      method: 'POST',
      apiKey: opts.apiKey,
      body: JSON.stringify({
        webhook: {
          enabled: true,
          url: opts.webhookUrl,
          // Only the events Axon needs — keep payload chatter minimal
          events: ['MESSAGES_UPSERT'],
          webhookByEvents: false,
          webhookBase64: false,
        },
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { ok: false, error: `Evolution set-webhook ${res.status}: ${text.slice(0, 240)}` };
    }
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err.message || String(err) };
  }
}

/** Send a text reply on the instance. */
export async function sendText(opts: {
  instanceUrl: string;
  instanceName: string;
  apiKey: string;
  number: string;       // raw phone like "5511999999999"
  text: string;
}): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await evoFetch(opts.instanceUrl, `/message/sendText/${encodeURIComponent(opts.instanceName)}`, {
      method: 'POST',
      apiKey: opts.apiKey,
      body: JSON.stringify({
        number: opts.number,
        text: opts.text,
        delay: 1200,        // small typing delay so replies don't feel robotic
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { ok: false, error: `sendText ${res.status}: ${body.slice(0, 200)}` };
    }
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err.message || String(err) };
  }
}

/**
 * Extract a plain user message from an Evolution `messages.upsert` event.
 * Handles `conversation` (plain text) and `extendedTextMessage.text` (replies/quotes/forwards).
 * Skips media-only messages, reactions, edits, and our own outgoing messages.
 */
export function extractInbound(payload: any): { phone: string; text: string; pushName: string } | null {
  if (!payload) return null;
  const event = payload.event || payload.type;
  if (event !== 'messages.upsert' && event !== 'MESSAGES_UPSERT') return null;
  const data = payload.data || payload;
  if (!data || data.key?.fromMe) return null;            // ignore our own sends
  const remote = data.key?.remoteJid as string | undefined;
  if (!remote || remote.endsWith('@g.us')) return null;  // skip group chats for now
  const phone = remote.split('@')[0];
  const m = data.message || {};
  const text =
    (typeof m.conversation === 'string' && m.conversation) ||
    (typeof m.extendedTextMessage?.text === 'string' && m.extendedTextMessage.text) ||
    (typeof m.imageMessage?.caption === 'string' && m.imageMessage.caption) ||
    null;
  if (!text) return null;
  return { phone, text, pushName: data.pushName || '' };
}
