/**
 * Request ID middleware.
 *
 * Generates a short ID per request (or respects an incoming `x-request-id`),
 * puts it in context and echoes it back as `x-request-id`. Logger picks it
 * up for structured logs so you can grep prod logs for a single request.
 */
import type { Context, Next } from 'hono';
import { randomBytes } from 'node:crypto';

export async function requestId(c: Context, next: Next) {
  const incoming = c.req.header('x-request-id');
  const id = incoming && /^[A-Za-z0-9_-]{1,64}$/.test(incoming)
    ? incoming
    : randomBytes(8).toString('hex'); // 16-hex-char short ID
  c.set('request_id', id);
  c.header('x-request-id', id);
  await next();
}
