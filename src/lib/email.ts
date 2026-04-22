/**
 * Transactional email sender — pluggable.
 *
 * Default mode: NOOP (logs to stdout). Enough for local dev.
 *
 * To actually send emails, wire one of:
 *   - Resend (https://resend.com) — easiest, free 3000/mo
 *   - SendGrid — free 100/day
 *   - Postmark — $15/mo for transactional
 *   - AWS SES — cheapest at scale
 *
 * Set EMAIL_PROVIDER=resend and RESEND_API_KEY=re_... to enable Resend.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { log } from './logger';

const TEMPLATE_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'emails',
);

export interface EmailVars {
  [key: string]: string | number;
}

export interface EmailResult {
  provider: string;
  id?: string;
  to: string;
  subject: string;
}

interface ParsedTemplate {
  subject: string;
  preheader?: string;
  body: string;
}

async function loadTemplate(name: string): Promise<ParsedTemplate> {
  const raw = await readFile(join(TEMPLATE_DIR, `${name}.md`), 'utf8');
  // Simple front-matter parse: everything between --- ... --- is YAML-ish.
  const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) throw new Error(`Template ${name} has no front-matter`);
  const front = Object.fromEntries(
    m[1].split('\n').map((l) => {
      const i = l.indexOf(':');
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    }),
  );
  return {
    subject: front.subject ?? '(no subject)',
    preheader: front.preheader,
    body: m[2],
  };
}

function render(s: string, vars: EmailVars): string {
  return s.replace(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g, (_, k) =>
    vars[k] === undefined ? `{{${k}}}` : String(vars[k]),
  );
}

export async function sendEmail(
  template: string,
  to: string,
  vars: EmailVars,
): Promise<EmailResult> {
  const tmpl = await loadTemplate(template);
  const subject = render(tmpl.subject, vars);
  const body = render(tmpl.body, vars);

  const provider = process.env.EMAIL_PROVIDER ?? 'noop';

  if (provider === 'resend' && process.env.RESEND_API_KEY) {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      },
      body: JSON.stringify({
        from: process.env.EMAIL_FROM ?? 'Axon <hi@axon.dev>',
        to,
        subject,
        text: body,
      }),
    });
    const json = (await res.json()) as { id?: string; message?: string };
    if (!res.ok) throw new Error(`Resend: ${json.message ?? res.statusText}`);
    log.info('email_sent', { provider: 'resend', to, template, id: json.id });
    return { provider: 'resend', id: json.id, to, subject };
  }

  // Noop / dev mode: write to stdout
  log.info('email_noop', { to, template, subject, body_preview: body.slice(0, 120) });
  return { provider: 'noop', to, subject };
}
