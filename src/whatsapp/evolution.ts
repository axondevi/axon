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
}): Promise<{ ok: boolean; messageId?: string; error?: string }> {
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
    // Capture the message ID so the webhook receiver can distinguish our
    // own sends from messages the human typed by hand on their phone (both
    // arrive as fromMe=true on the inbound webhook).
    const data: any = await res.json().catch(() => ({}));
    const messageId: string | undefined =
      data?.key?.id || data?.message?.key?.id || data?.id || undefined;
    return { ok: true, messageId };
  } catch (err: any) {
    return { ok: false, error: err.message || String(err) };
  }
}

/**
 * Provision a fresh Evolution instance on the SHARED Axon Evolution server.
 *
 * Returns the per-instance API key (`hash`) which we store encrypted on the
 * whatsapp_connections row. Subsequent calls (sendText, sendMedia, status
 * check, webhook config) authenticate with that per-instance key — NOT the
 * global one — so customer instances are isolated even on a shared server.
 *
 * Evolution v2.3.7 also returns the FIRST QR right in this response with a
 * `data:image/png;base64,` prefix, so callers don't need a follow-up
 * /instance/connect roundtrip for the initial pairing.
 *
 * Naming convention: `axon-<userIdPrefix>-<base36ts>` keeps it human-readable
 * for ops while staying unique.
 */
export async function createInstance(opts: {
  /** Shared Axon Evolution server URL (env: AXON_EVOLUTION_URL). */
  serverUrl: string;
  /** Global server API key (env: AXON_EVOLUTION_API_KEY). Used ONLY for create. */
  globalApiKey: string;
  /** Instance name to register — must be globally unique on this server. */
  instanceName: string;
  /** Optional webhook URL to register at the same time (saves a roundtrip). */
  webhookUrl?: string;
}): Promise<{
  ok: boolean;
  /** Per-instance API key — encrypt + store in whatsapp_connections.api_key. */
  apiKey?: string;
  instanceName?: string;
  instanceId?: string;
  /** First QR base64 (without data: prefix — caller handles rendering). */
  qrBase64?: string;
  /** Pix-style 8-char pairing code (only set when phoneNumber was passed). */
  pairingCode?: string;
  error?: string;
}> {
  try {
    const body: Record<string, unknown> = {
      instanceName: opts.instanceName,
      qrcode: true,
      integration: 'WHATSAPP-BAILEYS',
    };
    if (opts.webhookUrl) {
      // Evolution v2 inline-webhook format. Some builds want flat keys, others
      // a nested object — sending both keeps us forward-compatible.
      body.webhook = {
        enabled: true,
        url: opts.webhookUrl,
        events: ['MESSAGES_UPSERT'],
        webhookByEvents: false,
        webhookBase64: false,
      };
    }
    const res = await evoFetch(opts.serverUrl, '/instance/create', {
      method: 'POST',
      apiKey: opts.globalApiKey,
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { ok: false, error: `createInstance ${res.status}: ${text.slice(0, 240)}` };
    }
    const data: any = await res.json().catch(() => ({}));

    // QR base64 sometimes comes with `data:image/png;base64,` prefix — strip it
    // so callers can prepend a consistent prefix themselves.
    let qrBase64: string | undefined =
      data?.qrcode?.base64 || data?.qrcode?.code || undefined;
    if (typeof qrBase64 === 'string' && qrBase64.startsWith('data:image/')) {
      qrBase64 = qrBase64.split(',', 2)[1];
    }

    return {
      ok: true,
      apiKey: data?.hash,
      instanceName: data?.instance?.instanceName || opts.instanceName,
      instanceId: data?.instance?.instanceId,
      qrBase64,
      pairingCode: data?.qrcode?.pairingCode || undefined,
    };
  } catch (err: any) {
    return { ok: false, error: err.message || String(err) };
  }
}

/**
 * Delete an Evolution instance (cleanup when an agent is disconnected/deleted).
 *
 * Best-effort: returns ok:false on any error but never throws. Caller should
 * proceed with DB cleanup regardless — a stale Evolution instance is wasted
 * resources but won't break anything else.
 *
 * Some Evolution v2 builds require disconnecting (logout) BEFORE delete to
 * release the WhatsApp session cleanly. We try delete-only first since most
 * builds handle the implicit logout themselves.
 */
export async function deleteInstance(opts: {
  instanceUrl: string;
  instanceName: string;
  apiKey: string;
}): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await evoFetch(
      opts.instanceUrl,
      `/instance/delete/${encodeURIComponent(opts.instanceName)}`,
      { method: 'DELETE', apiKey: opts.apiKey },
    );
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { ok: false, error: `delete ${res.status}: ${text.slice(0, 200)}` };
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
    let qrBase64: string | undefined =
      (typeof data?.code === 'string' && data.code) ||
      (typeof data?.base64 === 'string' && data.base64) ||
      (typeof data?.qrcode?.code === 'string' && data.qrcode.code) ||
      (typeof data?.qrcode?.base64 === 'string' && data.qrcode.base64) ||
      undefined;
    // Some Evolution versions prefix with `data:image/png;base64,` — strip it
    // so the caller can render the raw base64 consistently.
    if (typeof qrBase64 === 'string' && qrBase64.startsWith('data:image/')) {
      qrBase64 = qrBase64.split(',', 2)[1];
    }

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
}): Promise<{ ok: boolean; messageId?: string; error?: string }> {
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
    const data: any = await res.json().catch(() => ({}));
    const messageId: string | undefined =
      data?.key?.id || data?.message?.key?.id || data?.id || undefined;
    return { ok: true, messageId };
  } catch (err: any) {
    return { ok: false, error: err.message || String(err) };
  }
}

/**
 * Download attached media (image / audio / document / video) from an
 * Evolution `messages.upsert` payload.
 *
 * Evolution v2.x exposes a base64 endpoint that re-fetches the media for
 * a given message ID — `POST /chat/getBase64FromMediaMessage/:instance`
 * with the message key. We use that because the inbound webhook does NOT
 * include the media bytes by default (only metadata + URL) — keeps the
 * webhook payload small even for big videos.
 *
 * Returns raw bytes + MIME so callers (Vision, STT) can process directly.
 */
export async function fetchMessageMedia(opts: {
  instanceUrl: string;
  instanceName: string;
  apiKey: string;
  /** The full data.message object from the inbound payload. */
  message: any;
  /** The data.key.id from the inbound payload. */
  messageKey: any;
}): Promise<{ ok: boolean; bytes?: Uint8Array; mimeType?: string; error?: string }> {
  try {
    const res = await evoFetch(
      opts.instanceUrl,
      `/chat/getBase64FromMediaMessage/${encodeURIComponent(opts.instanceName)}`,
      {
        method: 'POST',
        apiKey: opts.apiKey,
        body: JSON.stringify({
          message: { key: opts.messageKey, message: opts.message },
          convertToMp4: false,
        }),
      },
    );
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { ok: false, error: `getBase64 ${res.status}: ${text.slice(0, 200)}` };
    }
    const data: any = await res.json().catch(() => ({}));
    const b64: string | undefined = data?.base64 || data?.media || data?.fileBase64;
    const mimeType: string | undefined =
      data?.mimetype || data?.mediaType || 'application/octet-stream';
    if (!b64) {
      return { ok: false, error: `no base64 in response: ${JSON.stringify(data).slice(0, 160)}` };
    }
    // Strip optional `data:image/...;base64,` prefix
    const cleanB64 = b64.startsWith('data:') ? b64.split(',', 2)[1] : b64;
    const binary = atob(cleanB64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return { ok: true, bytes, mimeType };
  } catch (err: any) {
    return { ok: false, error: err.message || String(err) };
  }
}

/**
 * Extract a plain user message from an Evolution `messages.upsert` event.
 *
 * Returns:
 * - kind:'text'  — plain text or extended text reply
 * - kind:'image' — photo with optional caption (text = caption, may be empty)
 * - kind:'audio' — voice/audio message (text = '' since there's nothing to read)
 * - null         — group chats, our own sends, reactions, edits, unsupported
 *
 * Caller decides how to handle each kind: text → straight to LLM,
 * image → Vision describes → inject as text, audio → STT transcribes →
 * inject as text. All paths reach runAgent() the same way.
 *
 * `messageKey` + `messageRaw` are returned so callers can re-fetch the
 * media bytes via fetchMessageMedia() — Evolution doesn't include the
 * raw bytes in webhook payloads to keep them small.
 */
export interface InboundMessage {
  phone: string;
  pushName: string;
  kind: 'text' | 'image' | 'audio';
  text: string;                  // caption for media, transcript-target empty for audio
  messageKey?: any;              // for media re-fetch
  messageRaw?: any;              // for media re-fetch
  fromMe: boolean;               // true if WhatsApp account itself sent it (us OR a human typing)
  messageId?: string;            // Evolution's message ID — used to dedupe our own sends
}
export function extractInbound(payload: any): InboundMessage | null {
  if (!payload) return null;
  const event = payload.event || payload.type;
  if (event !== 'messages.upsert' && event !== 'MESSAGES_UPSERT') return null;
  const data = payload.data || payload;
  if (!data) return null;
  const remote = data.key?.remoteJid as string | undefined;
  if (!remote || remote.endsWith('@g.us')) return null;  // skip group chats for now
  const phone = remote.split('@')[0];
  const m = data.message || {};
  const messageKey = data.key;
  const fromMe = !!data.key?.fromMe;
  const messageId: string | undefined = data.key?.id || undefined;

  // Text message — fastest path, no media re-fetch needed.
  const plainText =
    (typeof m.conversation === 'string' && m.conversation) ||
    (typeof m.extendedTextMessage?.text === 'string' && m.extendedTextMessage.text) ||
    null;
  if (plainText) {
    return { phone, pushName: data.pushName || '', kind: 'text', text: plainText, fromMe, messageId };
  }

  // Image message — caption is optional. Even without caption, we still
  // process it (Vision describes "received a photo without caption").
  if (m.imageMessage) {
    return {
      phone,
      pushName: data.pushName || '',
      kind: 'image',
      text: typeof m.imageMessage.caption === 'string' ? m.imageMessage.caption : '',
      messageKey,
      messageRaw: m,
      fromMe,
      messageId,
    };
  }

  // Audio / voice messages (PTT = "push-to-talk"). Caption is rare but
  // possible (some clients allow it).
  if (m.audioMessage) {
    return {
      phone,
      pushName: data.pushName || '',
      kind: 'audio',
      text: typeof m.audioMessage.caption === 'string' ? m.audioMessage.caption : '',
      messageKey,
      messageRaw: m,
      fromMe,
      messageId,
    };
  }

  // Reactions, edits, stickers, locations, contacts — drop for now.
  return null;
}
