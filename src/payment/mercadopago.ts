/**
 * MercadoPago client — Pix payments only (cards/boleto out of scope).
 *
 * Why MercadoPago: it's the cheapest Pix gateway in BR for SaaS use
 * (~0.99% per transaction, instant settlement, no monthly fee). No KYC
 * roadblocks for foreign-owned accounts (unlike Stone/Cielo).
 *
 * Integration shape:
 *   1. Backend creates a Pix Payment via POST /v1/payments.
 *   2. Response includes `point_of_interaction.transaction_data.qr_code`
 *      (Pix copy-paste string) and `qr_code_base64` (PNG image).
 *   3. User pays via banking app.
 *   4. MP fires webhook to our /v1/webhooks/mercadopago endpoint.
 *   5. We re-fetch GET /v1/payments/:id to confirm status (server-to-
 *      server, never trust the webhook payload alone).
 *
 * Auth: bearer token from MP_ACCESS_TOKEN env (production credential
 * starts with `APP_USR-...`, sandbox with `TEST-...`).
 *
 * Docs: https://www.mercadopago.com.br/developers/en/reference/payments/_payments/post
 */

const MP_BASE = 'https://api.mercadopago.com';
const FETCH_TIMEOUT_MS = 15_000;

function token(): string {
  const t = process.env.MP_ACCESS_TOKEN;
  if (!t) throw new Error('MP_ACCESS_TOKEN env not configured');
  return t;
}

/**
 * True when MP integration is configured. Lets callers (e.g. the in-chat
 * `generate_pix` agent tool) silent-skip rather than throwing when the
 * operator hasn't wired MP creds yet.
 */
export function isMpConfigured(): boolean {
  return !!(process.env.MP_ACCESS_TOKEN && process.env.MP_ACCESS_TOKEN.trim());
}

async function mpFetch(path: string, init: RequestInit & { idempotencyKey?: string } = {}): Promise<Response> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(MP_BASE + path, {
      ...init,
      signal: ctl.signal,
      headers: {
        Authorization: `Bearer ${token()}`,
        'Content-Type': 'application/json',
        ...(init.idempotencyKey ? { 'X-Idempotency-Key': init.idempotencyKey } : {}),
        ...(init.headers || {}),
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

export interface PixCreateResult {
  ok: boolean;
  /** Internal MP payment id (number, store as string for safety). */
  mpId?: string;
  /** Copy-paste Pix code (BR Codes "EMV"). User pastes in any banking app. */
  qrCode?: string;
  /** PNG image as base64 (no data: prefix). Render via <img src="data:image/png;base64,..."/>. */
  qrCodeBase64?: string;
  /** When the Pix expires — typically 30 min after creation. */
  expiresAt?: string;
  /** Public ticket URL (alternative to QR — user opens, MP renders). */
  ticketUrl?: string;
  /** Initial status — usually 'pending'. */
  status?: string;
  error?: string;
}

/**
 * Create a Pix payment for `amountBrl` Brazilian Reais.
 *
 * `externalReference` is our internal pix_payments.id — MP echoes it back
 * on the webhook, letting us correlate without a DB lookup.
 *
 * `description` shows up on the user's banking app statement (max ~200 chars).
 *
 * `payerEmail` is required by MP for Pix. Use the user's signup email; if
 * unavailable, a deterministic placeholder works (e.g. `<userId>@axon.user`).
 */
export async function createPixPayment(opts: {
  amountBrl: number;
  externalReference: string;
  description: string;
  payerEmail: string;
  /** Idempotency: if set, MP rejects duplicate creates with the same key (24h window). */
  idempotencyKey?: string;
  /** Webhook URL — must be publicly reachable HTTPS. */
  notificationUrl?: string;
  /** Pix expiration in minutes (default 30). MP min 1, max 30 days. */
  expiresInMinutes?: number;
}): Promise<PixCreateResult> {
  if (!Number.isFinite(opts.amountBrl) || opts.amountBrl <= 0) {
    return { ok: false, error: 'amount must be > 0' };
  }
  // MP requires 2-decimal precision. Normalize to avoid floats like 50.000000001.
  const amount = Math.round(opts.amountBrl * 100) / 100;
  if (amount < 0.5) return { ok: false, error: 'minimum BRL 0.50' };

  const expiresInMs = (opts.expiresInMinutes ?? 30) * 60 * 1000;
  const dateOfExpiration = new Date(Date.now() + expiresInMs).toISOString();

  const body: Record<string, unknown> = {
    transaction_amount: amount,
    description: opts.description.slice(0, 200),
    payment_method_id: 'pix',
    payer: { email: opts.payerEmail },
    external_reference: opts.externalReference,
    date_of_expiration: dateOfExpiration,
  };
  if (opts.notificationUrl) body.notification_url = opts.notificationUrl;

  try {
    const res = await mpFetch('/v1/payments', {
      method: 'POST',
      body: JSON.stringify(body),
      idempotencyKey: opts.idempotencyKey,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { ok: false, error: `MP create ${res.status}: ${text.slice(0, 300)}` };
    }
    const data: any = await res.json();
    const tx = data?.point_of_interaction?.transaction_data;
    return {
      ok: true,
      mpId: String(data.id),
      qrCode: tx?.qr_code,
      qrCodeBase64: tx?.qr_code_base64,
      ticketUrl: tx?.ticket_url,
      expiresAt: dateOfExpiration,
      status: data.status,
    };
  } catch (err: any) {
    return { ok: false, error: err.message || String(err) };
  }
}

export interface PixPaymentStatus {
  ok: boolean;
  mpId?: string;
  /** 'pending' | 'approved' | 'authorized' | 'in_process' | 'rejected' | 'refunded' | 'cancelled' | 'in_mediation' | 'charged_back' */
  status?: string;
  statusDetail?: string;
  amountBrl?: number;
  netReceivedBrl?: number;
  externalReference?: string;
  approvedAt?: string;
  payerEmail?: string;
  error?: string;
}

/** Re-fetch payment from MP — never trust webhook payload alone (could be spoofed). */
export async function getPayment(mpId: string): Promise<PixPaymentStatus> {
  try {
    const res = await mpFetch(`/v1/payments/${encodeURIComponent(mpId)}`, { method: 'GET' });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { ok: false, error: `MP get ${res.status}: ${text.slice(0, 300)}` };
    }
    const d: any = await res.json();
    return {
      ok: true,
      mpId: String(d.id),
      status: d.status,
      statusDetail: d.status_detail,
      amountBrl: typeof d.transaction_amount === 'number' ? d.transaction_amount : undefined,
      netReceivedBrl: typeof d.transaction_details?.net_received_amount === 'number'
        ? d.transaction_details.net_received_amount
        : undefined,
      externalReference: d.external_reference || undefined,
      approvedAt: d.date_approved || undefined,
      payerEmail: d.payer?.email || undefined,
    };
  } catch (err: any) {
    return { ok: false, error: err.message || String(err) };
  }
}

/**
 * Verify MP webhook x-signature header.
 *
 * MP sends: `ts=<unix>,v1=<hmac-sha256-hex>` in `x-signature` header.
 * The signed manifest is: `id:<dataId>;request-id:<requestId>;ts:<ts>;`
 * (literal semicolons, trailing semicolon required).
 *
 * Returns true if signature valid AND timestamp within 5min skew.
 */
export async function verifyWebhookSignature(opts: {
  signatureHeader: string | null;
  requestIdHeader: string | null;
  /** Resource id from query string `?data.id=...` */
  dataId: string;
  /** Pre-shared secret from MP webhook config (MP_WEBHOOK_SECRET). */
  secret: string;
}): Promise<{ valid: boolean; reason?: string }> {
  if (!opts.signatureHeader) return { valid: false, reason: 'missing x-signature' };
  if (!opts.secret) return { valid: false, reason: 'MP_WEBHOOK_SECRET not configured' };
  if (!opts.dataId) return { valid: false, reason: 'missing data.id' };

  // Parse "ts=...,v1=..." pairs
  const parts: Record<string, string> = {};
  for (const p of opts.signatureHeader.split(',')) {
    const [k, v] = p.split('=');
    if (k && v) parts[k.trim()] = v.trim();
  }
  if (!parts.ts || !parts.v1) return { valid: false, reason: 'malformed signature' };

  // 5-minute timestamp skew window — defends against replay attacks
  const tsMs = Number(parts.ts) * 1000;
  if (!Number.isFinite(tsMs)) return { valid: false, reason: 'bad ts' };
  if (Math.abs(Date.now() - tsMs) > 5 * 60 * 1000) {
    return { valid: false, reason: 'ts out of window' };
  }

  const manifest = `id:${opts.dataId};request-id:${opts.requestIdHeader || ''};ts:${parts.ts};`;

  // HMAC-SHA256 via Web Crypto (Bun + Node 20+ have it)
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(opts.secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(manifest));
  const expected = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  // Constant-time comparison — `expected === parts.v1` short-circuits on
  // first byte mismatch, leaking position via response time. An attacker
  // forging signatures bytes-at-a-time uses that side channel; we don't
  // give them the wedge.
  return constantTimeStringEqual(expected, parts.v1)
    ? { valid: true }
    : { valid: false, reason: 'hmac mismatch' };
}

function constantTimeStringEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}
