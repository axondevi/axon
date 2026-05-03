/**
 * Appointments routes — owner-facing CRUD + cron reminder endpoint.
 *
 *   GET    /v1/agents/:id/contacts/:phone/appointments  → list per contact
 *   GET    /v1/agents/:id/appointments                  → list per agent
 *   PATCH  /v1/appointments/:id                         → owner edit (status, scheduled_for, etc)
 *   DELETE /v1/appointments/:id                         → cancel/remove
 *   POST   /v1/admin/cron/appointment-reminders         → invoked daily by GitHub Action
 *                                                          (auth via x-admin-key)
 *
 * Reminder logic:
 *   The cron endpoint scans for `scheduled_for` between (now+18h, now+30h)
 *   and `status IN ('confirmed', 'pending')` and `'d-1' NOT IN reminders_sent`,
 *   then sends a WhatsApp text via the agent's Evolution connection. Each
 *   appointment fires the D-1 reminder exactly once thanks to the
 *   reminders_sent JSONB tag.
 */
import { Hono } from 'hono';
import { eq, and, gte, lte, inArray, desc } from 'drizzle-orm';
import { db } from '~/db';
import {
  agents,
  appointments,
  contactMemory,
  whatsappConnections,
} from '~/db/schema';
import { Errors } from '~/lib/errors';
import { decrypt } from '~/lib/crypto';
import { sendText } from '~/whatsapp/evolution';
import { recordSentId } from '~/whatsapp/sent-ids';
import { log } from '~/lib/logger';

// Two routers because the paths split into two prefixes:
//   /v1/agents/:id/...         → ownerAppointments  (mounted under /agents)
//   /v1/appointments/:id PATCH/DELETE → ownerAppointmentsRoot (mounted at /)
export const ownerAppointments = new Hono();
export const ownerAppointmentsRoot = new Hono();
export const adminCron = new Hono();

async function requireOwnedAgent(userId: string, agentId: string) {
  const [a] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.ownerId, userId)))
    .limit(1);
  if (!a) throw Errors.notFound('Agent');
  return a;
}

// ─── List per-contact ──────────────────────────────────────
ownerAppointments.get('/:id/contacts/:phone/appointments', async (c) => {
  const user = c.get('user') as { id: string };
  const agentId = c.req.param('id');
  const phone = c.req.param('phone');
  await requireOwnedAgent(user.id, agentId);

  const rows = await db
    .select()
    .from(appointments)
    .where(and(eq(appointments.agentId, agentId), eq(appointments.contactPhone, phone)))
    .orderBy(desc(appointments.scheduledFor))
    .limit(100);

  return c.json({
    appointments: rows.map((r) => ({
      id: r.id,
      scheduled_for: r.scheduledFor,
      duration_minutes: r.durationMinutes,
      description: r.description,
      location: r.location,
      status: r.status,
      reminders_sent: r.remindersSent,
      contact_name: r.contactName,
      created_at: r.createdAt,
    })),
  });
});

// ─── List per-agent ────────────────────────────────────────
// Useful for an agent-wide schedule view (next 30 days). Filters: ?status=confirmed&from=ISO&to=ISO.
ownerAppointments.get('/:id/appointments', async (c) => {
  const user = c.get('user') as { id: string };
  const agentId = c.req.param('id');
  await requireOwnedAgent(user.id, agentId);

  const filters = [eq(appointments.agentId, agentId)];
  const from = c.req.query('from');
  const to = c.req.query('to');
  const status = c.req.query('status');
  if (from) {
    const d = new Date(from);
    if (!Number.isNaN(d.getTime())) filters.push(gte(appointments.scheduledFor, d));
  }
  if (to) {
    const d = new Date(to);
    if (!Number.isNaN(d.getTime())) filters.push(lte(appointments.scheduledFor, d));
  }
  if (status) filters.push(eq(appointments.status, status));

  const rows = await db
    .select()
    .from(appointments)
    .where(and(...filters))
    .orderBy(desc(appointments.scheduledFor))
    .limit(200);

  return c.json({
    appointments: rows.map((r) => ({
      id: r.id,
      scheduled_for: r.scheduledFor,
      duration_minutes: r.durationMinutes,
      description: r.description,
      location: r.location,
      status: r.status,
      contact_name: r.contactName,
      contact_phone: r.contactPhone,
      reminders_sent: r.remindersSent,
    })),
  });
});

// ─── Owner edit / cancel ───────────────────────────────────
ownerAppointmentsRoot.patch('/appointments/:appointmentId', async (c) => {
  const user = c.get('user') as { id: string };
  const aptId = c.req.param('appointmentId');

  const [apt] = await db.select().from(appointments).where(eq(appointments.id, aptId)).limit(1);
  if (!apt) throw Errors.notFound('Appointment');
  await requireOwnedAgent(user.id, apt.agentId);

  const body = await c.req.json().catch(() => ({} as any));
  const updates: Partial<typeof appointments.$inferInsert> = { updatedAt: new Date() };
  if ('status' in body) {
    const valid = ['confirmed', 'pending', 'cancelled', 'done', 'no_show'];
    if (!valid.includes(body.status)) {
      return c.json({ error: 'bad_request', message: `status must be one of: ${valid.join(',')}` }, 400);
    }
    updates.status = body.status;
  }
  if ('scheduled_for' in body) {
    const d = new Date(body.scheduled_for);
    if (Number.isNaN(d.getTime())) return c.json({ error: 'bad_request', message: 'scheduled_for invalid' }, 400);
    updates.scheduledFor = d;
    // Reset reminders if rescheduling to a future date — lets the cron
    // fire D-1 again for the new date.
    updates.remindersSent = [] as unknown as object;
  }
  if ('description' in body) updates.description = String(body.description).slice(0, 200);
  if ('location' in body) updates.location = body.location ? String(body.location).slice(0, 200) : null;
  if ('duration_minutes' in body && typeof body.duration_minutes === 'number') {
    updates.durationMinutes = Math.max(1, Math.min(480, Math.round(body.duration_minutes)));
  }

  await db.update(appointments).set(updates).where(eq(appointments.id, aptId));
  return c.json({ ok: true });
});

ownerAppointmentsRoot.delete('/appointments/:appointmentId', async (c) => {
  const user = c.get('user') as { id: string };
  const aptId = c.req.param('appointmentId');

  const [apt] = await db.select().from(appointments).where(eq(appointments.id, aptId)).limit(1);
  if (!apt) throw Errors.notFound('Appointment');
  await requireOwnedAgent(user.id, apt.agentId);

  await db.delete(appointments).where(eq(appointments.id, aptId));
  return c.json({ ok: true });
});

// ─── PT-BR datetime formatter for reminder copy ────────────
function formatBR(iso: Date): string {
  // Format: "segunda-feira, 4 de maio às 13:00"
  const opts: Intl.DateTimeFormatOptions = {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'America/Sao_Paulo',
  };
  const fmt = new Intl.DateTimeFormat('pt-BR', opts).format(iso);
  // pt-BR yields "segunda-feira, 4 de maio, 13:00" — replace last comma+space with " às "
  return fmt.replace(/,\s+(\d{2}:\d{2})$/, ' às $1');
}

function firstName(name: string | null | undefined): string {
  if (!name) return '';
  const first = name.trim().split(/\s+/)[0];
  return first ? `, ${first}` : '';
}

// ─── Cron — daily D-1 reminders ────────────────────────────
//
// Auth: shared `x-admin-key` header against env ADMIN_API_KEY. The
// GitHub Action passes this from a repo secret. Local dev: invoke
// curl with the same header.
adminCron.post('/cron/appointment-reminders', async (c) => {
  const adminKey = c.req.header('x-admin-key');
  if (!adminKey || adminKey !== process.env.ADMIN_API_KEY) {
    return c.json({ error: 'unauthorized' }, 401);
  }

  // Optional ?force=1 to bypass the time window — useful for the very
  // first manual test from the GitHub Action's workflow_dispatch run.
  // In that mode we still respect reminders_sent so we don't double-send.
  const force = c.req.query('force') === '1';
  const now = new Date();
  const start = new Date(now.getTime() + 18 * 60 * 60 * 1000);
  const end = new Date(now.getTime() + 30 * 60 * 60 * 1000);

  const filters = force
    ? [inArray(appointments.status, ['confirmed', 'pending'])]
    : [
        gte(appointments.scheduledFor, start),
        lte(appointments.scheduledFor, end),
        inArray(appointments.status, ['confirmed', 'pending']),
      ];

  const candidates = await db
    .select()
    .from(appointments)
    .where(and(...filters))
    .limit(500);

  let sent = 0;
  let skipped = 0;
  let failed = 0;
  const details: Array<{ id: string; outcome: string; error?: string }> = [];

  for (const apt of candidates) {
    const tagsArr = Array.isArray(apt.remindersSent) ? (apt.remindersSent as string[]) : [];
    if (tagsArr.includes('d-1')) {
      skipped++;
      details.push({ id: apt.id, outcome: 'already-sent' });
      continue;
    }
    // Look up the WhatsApp connection for this agent.
    const [conn] = await db
      .select()
      .from(whatsappConnections)
      .where(eq(whatsappConnections.agentId, apt.agentId))
      .limit(1);
    if (!conn) {
      failed++;
      details.push({ id: apt.id, outcome: 'no-conn' });
      continue;
    }
    let apiKey: string;
    try {
      apiKey = decrypt(conn.apiKey);
    } catch {
      failed++;
      details.push({ id: apt.id, outcome: 'decrypt-fail' });
      continue;
    }

    // Fetch agent name for warmth in the message.
    const [agentRow] = await db.select().from(agents).where(eq(agents.id, apt.agentId)).limit(1);
    const agentName = agentRow?.name?.trim() || 'a equipe';

    const whenStr = formatBR(apt.scheduledFor);
    const desc = apt.description ? apt.description : 'sua consulta';
    const text =
      `Oi${firstName(apt.contactName)}! Lembrando que ${desc} está marcado pra ${whenStr}` +
      (apt.location ? ` em ${apt.location}` : '') +
      `. Tudo certo do seu lado? Se precisar remarcar é só me avisar 🙂\n\n— ${agentName}`;

    const r = await sendText({
      instanceUrl: conn.instanceUrl,
      instanceName: conn.instanceName,
      apiKey,
      number: apt.contactPhone,
      text,
      delayMs: 800,
    }).catch((err: any) => ({ ok: false, error: err?.message || String(err) } as const));

    if (r.ok) {
      if ((r as { messageId?: string }).messageId) {
        recordSentId((r as { messageId: string }).messageId);
      }
      const newTags = [...tagsArr, 'd-1'];
      await db
        .update(appointments)
        .set({ remindersSent: newTags as unknown as object, updatedAt: new Date() })
        .where(eq(appointments.id, apt.id));
      sent++;
      details.push({ id: apt.id, outcome: 'sent' });
      void import('~/lib/metrics').then(({ bumpCounter }) => {
        bumpCounter('axon_appointment_reminder_sent_total', { tag: 'd-1' });
      });
      // Subscription usage — counts toward included reminders quota.
      void import('~/payment/usage').then((m) => m.trackReminder(apt.agentId)).catch(() => {});
    } else {
      failed++;
      details.push({ id: apt.id, outcome: 'send-fail', error: (r as { error?: string }).error });
      log.warn('appointment_reminder_send_failed', {
        appointment_id: apt.id,
        error: (r as { error?: string }).error,
      });
    }
  }

  return c.json({
    ok: true,
    found: candidates.length,
    sent,
    skipped,
    failed,
    forced: force,
    details: details.slice(0, 20),
  });
});
