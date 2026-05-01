/**
 * Email transactional sender — Resend.
 *
 * Why Resend: 3k emails/mo free, dead-simple REST API, modern (no SMTP),
 * good deliverability out of the box. Founder-led so the API is unlikely
 * to break in subtle ways.
 *
 * Behavior:
 * - When RESEND_API_KEY is unset, sendEmail() becomes a no-op that just
 *   logs the would-have-sent at INFO. Local dev / test envs Just Work.
 * - On API error (4xx/5xx), we log at WARN and resolve `{ ok: false }`
 *   — callers MUST treat email as best-effort, never block flows on it.
 *   Use `void sendEmail(...)` to make fire-and-forget intent obvious.
 *
 * Address format: EMAIL_FROM env can be a bare address (`oi@axon.com.br`)
 * or display-format (`"Axon <oi@axon.com.br>"`). Resend accepts both.
 *
 * Production setup:
 *   1. Sign up at resend.com (free)
 *   2. Add a sending domain (e.g. axon.com.br) — DNS verification ~10min
 *   3. Generate an API key with sending scope
 *   4. Set RESEND_API_KEY + EMAIL_FROM on Render
 */
import { log } from '~/lib/logger';

const RESEND_BASE = 'https://api.resend.com';

export interface SendEmailResult {
  ok: boolean;
  id?: string;
  /** Reason why no email was sent — handy for tests & dashboards. */
  skipped?: 'no_api_key' | 'no_to' | 'no_from';
  error?: string;
}

export async function sendEmail(opts: {
  to: string | string[];
  subject: string;
  html: string;
  text?: string;
  /** Override default EMAIL_FROM for one-off transactional sends. */
  from?: string;
  /** Tag for filtering in Resend dashboard (e.g. 'welcome', 'pix_approved'). */
  tag?: string;
}): Promise<SendEmailResult> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = opts.from || process.env.EMAIL_FROM;

  if (!apiKey) {
    const { redactEmail } = await import('~/lib/logger');
    const toLog = Array.isArray(opts.to) ? opts.to.map(redactEmail) : redactEmail(opts.to);
    log.info('email.skipped', { reason: 'no_api_key', subject: opts.subject, to: toLog });
    return { ok: false, skipped: 'no_api_key' };
  }
  if (!from) {
    log.warn('email.skipped', { reason: 'no_from', subject: opts.subject });
    return { ok: false, skipped: 'no_from' };
  }
  const to = Array.isArray(opts.to) ? opts.to : [opts.to];
  if (to.length === 0 || !to[0]) {
    return { ok: false, skipped: 'no_to' };
  }

  const body: Record<string, unknown> = {
    from,
    to,
    subject: opts.subject,
    html: opts.html,
  };
  if (opts.text) body.text = opts.text;
  if (opts.tag) body.tags = [{ name: 'category', value: opts.tag }];

  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 10_000);
    const res = await fetch(`${RESEND_BASE}/emails`, {
      method: 'POST',
      signal: ctl.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    clearTimeout(timer);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      log.warn('email.send_failed', {
        status: res.status,
        subject: opts.subject,
        tag: opts.tag,
        error: text.slice(0, 240),
      });
      return { ok: false, error: `resend ${res.status}: ${text.slice(0, 120)}` };
    }
    const data: any = await res.json().catch(() => ({}));
    const { redactEmail } = await import('~/lib/logger');
    log.info('email.sent', {
      id: data.id,
      to: redactEmail(to[0]),
      subject: opts.subject,
      tag: opts.tag,
    });
    return { ok: true, id: data.id };
  } catch (err: any) {
    log.warn('email.send_error', { subject: opts.subject, error: err.message || String(err) });
    return { ok: false, error: err.message || String(err) };
  }
}
