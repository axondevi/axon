/**
 * Outbound webhook emitter.
 *
 * Fire-and-forget with retry-on-fail. Spawns a promise to POST to every
 * active subscription that wants this event. Delivery logs are persisted
 * for audit / manual retry.
 *
 * Signature: header `x-axon-signature: sha256=HEX` where HEX is
 *   HMAC-SHA256(subscription.secret, raw_body)
 *
 * Delivery timeout: 10s. Failed deliveries are logged; retry mechanism is
 * manual via admin endpoint (roadmap: automatic backoff).
 */
import { createHmac, randomUUID } from 'node:crypto';
import { eq, and } from 'drizzle-orm';
import { db } from '~/db';
import { webhookSubscriptions, webhookDeliveries } from '~/db/schema';
import { log } from '~/lib/logger';
import type { WebhookEvent, WebhookPayload } from './events';

const TIMEOUT_MS = 10_000;
const USER_AGENT = 'Axon-Webhook/0.1';

export function emitWebhook<T>(
  userId: string,
  event: WebhookEvent,
  data: T,
): void {
  // Fire-and-forget; don't block the caller.
  emit(userId, event, data).catch((err) => {
    log.warn('webhook_emit_error', { error: (err as Error).message, event });
  });
}

async function emit<T>(
  userId: string,
  event: WebhookEvent,
  data: T,
): Promise<void> {
  const subs = await db
    .select()
    .from(webhookSubscriptions)
    .where(
      and(eq(webhookSubscriptions.userId, userId), eq(webhookSubscriptions.active, true)),
    );

  if (subs.length === 0) return;

  const payload: WebhookPayload<T> = {
    id: randomUUID(),
    event,
    created_at: new Date().toISOString(),
    user_id: userId,
    data,
  };

  for (const sub of subs) {
    const events = sub.events as unknown as string[];
    if (!events.includes(event)) continue;
    deliver(sub.id, sub.url, sub.secret, payload).catch(() => {});
  }
}

async function deliver(
  subscriptionId: string,
  url: string,
  secret: string,
  payload: WebhookPayload<unknown>,
) {
  const body = JSON.stringify(payload);
  const sig = createHmac('sha256', secret).update(body, 'utf8').digest('hex');

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);

  let status = 0;
  let error: string | null = null;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': USER_AGENT,
        'x-axon-event': payload.event,
        'x-axon-delivery-id': payload.id,
        'x-axon-signature': `sha256=${sig}`,
      },
      body,
      signal: ctrl.signal,
    });
    status = res.status;
    if (status >= 400) error = `HTTP ${status}`;
  } catch (err) {
    error = (err as Error).message;
  } finally {
    clearTimeout(timer);
  }

  await db.insert(webhookDeliveries).values({
    subscriptionId,
    event: payload.event,
    payload,
    attempts: 1,
    lastStatus: status || null,
    lastError: error,
    deliveredAt: error ? null : new Date(),
  });

  if (error) {
    log.warn('webhook_delivery_failed', {
      subscription_id: subscriptionId,
      event: payload.event,
      status,
      error,
    });
  } else {
    log.info('webhook_delivered', {
      subscription_id: subscriptionId,
      event: payload.event,
      status,
    });
  }
}
