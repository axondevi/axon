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

/**
 * Send a text reply on the instance.
 *
 * delayMs controls Evolution's typing-simulation pause BEFORE the message
 * appears on the recipient's screen ("typing..." indicator visible during it).
 * Default 1200ms. Caller may scale to message length for natural feel
 * (e.g. longer messages → longer typing).
 */
export async function sendText(opts: {
  instanceUrl: string;
  instanceName: string;
  apiKey: string;
  number: string;       // raw phone like "5511999999999"
  text: string;
  delayMs?: number;
}): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await evoFetch(opts.instanceUrl, `/message/sendText/${encodeURIComponent(opts.instanceName)}`, {
      method: 'POST',
      apiKey: opts.apiKey,
      body: JSON.stringify({
        number: opts.number,
        text: opts.text,
        delay: opts.delayMs ?? 1200,
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
 * Trigger pairing on an Evolution instance — returns QR code + pairing code.
 *
 * Called when the instance is in `close`/`connecting` state (not yet paired
 * to a phone). Evolution v2 has two response shapes we tolerate:
 *
 *   v2.x newer:  { code: "<base64-png>", pairingCode: "ABCD1234", count: 1 }
 *   v2.x older:  { qrcode: { code: "<base64-png>", pairingCode: "..." } }
 *
 * The `code` field is a **PNG image as base64** (not a string for QR libs).
 * Caller renders it as `<img src="data:image/png;base64,${code}">` directly.
 *
 * pairingCode is the 8-digit "Connect with phone number" alternative —
 * easier on mobile because no camera is needed (entered in WhatsApp UI).
 *
 * No-op if the instance is already paired (state=open) — Evolution returns
 * empty/redundant data. Caller should checkInstance() first when in doubt.
 */
export async function connectInstance(opts: {
  instanceUrl: string;
  instanceName: string;
  apiKey: string;
  /** Optional: phone number (digits only) to pre-fill pairing code request. */
  phoneNumber?: string;
}): Promise<{
  ok: boolean;
  qrBase64?: string;
  pairingCode?: string;
  error?: string;
}> {
  try {
    const path = `/instance/connect/${encodeURIComponent(opts.instanceName)}` +
      (opts.phoneNumber ? `?number=${encodeURIComponent(opts.phoneNumber)}` : '');
    const res = await evoFetch(opts.instanceUrl, path, {
      method: 'GET',
      apiKey: opts.apiKey,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { ok: false, error: `connect ${res.status}: ${text.slice(0, 240)}` };
    }
    const data: any = await res.json().catch(() => ({}));

    // Normalize across the two known response shapes.
    const qrBase64 =
      (typeof data?.code === 'string' && data.code) ||
      (typeof data?.base64 === 'string' && data.base64) ||
      (typeof data?.qrcode?.code === 'string' && data.qrcode.code) ||
      (typeof data?.qrcode?.base64 === 'string' && data.qrcode.base64) ||
      undefined;

    const pairingCode =
      (typeof data?.pairingCode === 'string' && data.pairingCode) ||
      (typeof data?.qrcode?.pairingCode === 'string' && data.qrcode.pairingCode) ||
      undefined;

    if (!qrBase64 && !pairingCode) {
      // Either misconfig or already paired — surface the raw payload to help debug.
      return {
        ok: false,
        error: `Evolution connect returned no qr/pairing. Raw: ${JSON.stringify(data).slice(0, 200)}`,
      };
    }

    return { ok: true, qrBase64, pairingCode };
  } catch (err: any) {
    return { ok: false, error: err.message || String(err) };
  }
}

/**
 * Send a media message (image, document, video, audio) on the instance.
 *
 * Accepts either a public URL (`media`) or raw base64 (`base64Data`, no data:
 * prefix). Caption is optional. Evolution's `/message/sendMedia/{instance}`
 * endpoint handles MIME detection from the file extension or base64 prefix.
 *
 * For image generation flows (Stability returns base64), pass `base64Data`.
 * For shared external assets, pass `media` (URL).
 */
export async function sendMedia(opts: {
  instanceUrl: string;
  instanceName: string;
  apiKey: string;
  number: string;
  /** Public URL — used if base64Data is not provided. */
  media?: string;
  /** Raw base64 (no `data:image/...;base64,` prefix). */
  base64Data?: string;
  /** 'image' | 'document' | 'video' | 'audio' */
  mediatype?: 'image' | 'document' | 'video' | 'audio';
  /** MIME (e.g. 'image/png'). Defaults to image/png when mediatype=image. */
  mimetype?: string;
  /** Filename Evolution will attach (helps Whatsapp display). */
  fileName?: string;
  caption?: string;
  delayMs?: number;
}): Promise<{ ok: boolean; error?: string }> {
  if (!opts.media && !opts.base64Data) {
    return { ok: false, error: 'sendMedia: must provide media (URL) or base64Data' };
  }
  const mediatype = opts.mediatype || 'image';
  const mimetype = opts.mimetype || (mediatype === 'image' ? 'image/png' : 'application/octet-stream');
  const body: Record<string, unknown> = {
    number: opts.number,
    mediatype,
    mimetype,
    caption: opts.caption ?? '',
    fileName: opts.fileName || (mediatype === 'image' ? 'image.png' : 'file'),
    delay: opts.delayMs ?? 1200,
  };
  // Evolution accepts either { media: <url> } or { media: <base64> }.
  // Most builds expect raw base64 in the `media` field; some require
  // `mediaMessage.media`. We use the top-level `media` form which works on
  // Evolution v2.x (the build used in production per project memory).
  body.media = opts.base64Data || opts.media;
  try {
    const res = await evoFetch(
      opts.instanceUrl,
      `/message/sendMedia/${encodeURIComponent(opts.instanceName)}`,
      {
        method: 'POST',
        apiKey: opts.apiKey,
        body: JSON.stringify(body),
      },
    );
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { ok: false, error: `sendMedia ${res.status}: ${text.slice(0, 200)}` };
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
