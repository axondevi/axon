import { describe, it, expect } from 'bun:test';
import { verifyWebhookSignature } from '../payment/mercadopago';
import { createHmac } from 'node:crypto';

// Build a valid MercadoPago x-signature header for given inputs.
function buildSignature(opts: {
  ts: number;
  dataId: string;
  requestId: string;
  secret: string;
}): string {
  const manifest = `id:${opts.dataId};request-id:${opts.requestId};ts:${opts.ts};`;
  const h = createHmac('sha256', opts.secret).update(manifest).digest('hex');
  return `ts=${opts.ts},v1=${h}`;
}

describe('mercadopago verifyWebhookSignature', () => {
  const SECRET = 'test_webhook_secret_with_some_entropy';
  const DATA_ID = '12345678901';
  const REQUEST_ID = 'req-abc-123';

  it('accepts a fresh, correctly-signed payload', async () => {
    const ts = Math.floor(Date.now() / 1000);
    const sig = buildSignature({ ts, dataId: DATA_ID, requestId: REQUEST_ID, secret: SECRET });

    const r = await verifyWebhookSignature({
      signatureHeader: sig,
      requestIdHeader: REQUEST_ID,
      dataId: DATA_ID,
      secret: SECRET,
    });

    expect(r.valid).toBe(true);
  });

  it('rejects when the secret differs', async () => {
    const ts = Math.floor(Date.now() / 1000);
    const sig = buildSignature({ ts, dataId: DATA_ID, requestId: REQUEST_ID, secret: 'wrong-secret' });

    const r = await verifyWebhookSignature({
      signatureHeader: sig,
      requestIdHeader: REQUEST_ID,
      dataId: DATA_ID,
      secret: SECRET,
    });

    expect(r.valid).toBe(false);
    expect(r.reason).toBe('hmac mismatch');
  });

  it('rejects a single-byte tampered HMAC (timing-attack vector)', async () => {
    const ts = Math.floor(Date.now() / 1000);
    const sig = buildSignature({ ts, dataId: DATA_ID, requestId: REQUEST_ID, secret: SECRET });
    // Flip the LAST hex digit of v1 — naïve === equality used to short-circuit
    // on the first mismatched byte; constant-time comparison must still reject.
    const tampered = sig.slice(0, -1) + (sig.slice(-1) === '0' ? '1' : '0');

    const r = await verifyWebhookSignature({
      signatureHeader: tampered,
      requestIdHeader: REQUEST_ID,
      dataId: DATA_ID,
      secret: SECRET,
    });

    expect(r.valid).toBe(false);
    expect(r.reason).toBe('hmac mismatch');
  });

  it('rejects a payload outside the 5-minute window', async () => {
    const ts = Math.floor(Date.now() / 1000) - 10 * 60; // 10min old
    const sig = buildSignature({ ts, dataId: DATA_ID, requestId: REQUEST_ID, secret: SECRET });

    const r = await verifyWebhookSignature({
      signatureHeader: sig,
      requestIdHeader: REQUEST_ID,
      dataId: DATA_ID,
      secret: SECRET,
    });

    expect(r.valid).toBe(false);
    expect(r.reason).toBe('ts out of window');
  });

  it('rejects when x-signature is missing', async () => {
    const r = await verifyWebhookSignature({
      signatureHeader: null,
      requestIdHeader: REQUEST_ID,
      dataId: DATA_ID,
      secret: SECRET,
    });

    expect(r.valid).toBe(false);
    expect(r.reason).toBe('missing x-signature');
  });

  it('rejects when secret is empty', async () => {
    const ts = Math.floor(Date.now() / 1000);
    const sig = buildSignature({ ts, dataId: DATA_ID, requestId: REQUEST_ID, secret: SECRET });

    const r = await verifyWebhookSignature({
      signatureHeader: sig,
      requestIdHeader: REQUEST_ID,
      dataId: DATA_ID,
      secret: '',
    });

    expect(r.valid).toBe(false);
    expect(r.reason).toBe('MP_WEBHOOK_SECRET not configured');
  });

  it('rejects when dataId is missing', async () => {
    const ts = Math.floor(Date.now() / 1000);
    const sig = buildSignature({ ts, dataId: '', requestId: REQUEST_ID, secret: SECRET });

    const r = await verifyWebhookSignature({
      signatureHeader: sig,
      requestIdHeader: REQUEST_ID,
      dataId: '',
      secret: SECRET,
    });

    expect(r.valid).toBe(false);
    expect(r.reason).toBe('missing data.id');
  });

  it('rejects malformed signature header', async () => {
    const r = await verifyWebhookSignature({
      signatureHeader: 'not-valid-format',
      requestIdHeader: REQUEST_ID,
      dataId: DATA_ID,
      secret: SECRET,
    });

    expect(r.valid).toBe(false);
    expect(r.reason).toBe('malformed signature');
  });
});
