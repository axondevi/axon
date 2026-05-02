/**
 * Minimal TOTP (RFC 6238) implementation.
 *
 *   const secret = generateSecret();             // 20 random bytes
 *   const uri    = otpauthUri(secret, label, issuer);
 *   const code   = generateCode(secret);         // current 6-digit code
 *   const ok     = verifyCode(secret, '123456');
 *
 * No external dependency — uses Node's built-in HMAC. Window-1 means
 * we accept the previous + current + next 30s bucket so a slow user
 * (or device with mild clock skew) can still authenticate.
 *
 * Recovery codes are 10 random base32 segments, single-use; the
 * caller stores them encrypted and pops on success.
 */
import { createHmac, randomBytes } from 'node:crypto';

const PERIOD_SEC = 30;
const DIGITS = 6;
const ALG = 'sha1';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 4648 base32 (no padding). Standard for otpauth URIs. */
export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (let i = 0; i < buf.length; i++) {
    value = (value << 8) | buf[i]!;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 0x1f];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 0x1f];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.replace(/\s+/g, '').toUpperCase().replace(/=+$/, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error('invalid base32 char: ' + ch);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** 20 random bytes, ~160 bits of entropy. */
export function generateSecret(): Buffer {
  return randomBytes(20);
}

/**
 * Build an `otpauth://totp/...` URI for the QR code that user scans
 * in their authenticator app. `label` typically is `Axon:user@email`.
 */
export function otpauthUri(secret: Buffer, label: string, issuer: string): string {
  const params = new URLSearchParams({
    secret: base32Encode(secret),
    issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(PERIOD_SEC),
  });
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(label)}?${params}`;
}

function counterAt(timeSec: number): Buffer {
  const counter = Math.floor(timeSec / PERIOD_SEC);
  const buf = Buffer.alloc(8);
  // Big-endian 64-bit; JS numbers are safe up to 2^53 and counters at
  // 30s buckets max out at ~year-9999 well below that.
  buf.writeBigUInt64BE(BigInt(counter));
  return buf;
}

function hotp(secret: Buffer, counterBuf: Buffer): string {
  const hmac = createHmac(ALG, secret).update(counterBuf).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const bin =
    ((hmac[offset]! & 0x7f) << 24) |
    ((hmac[offset + 1]! & 0xff) << 16) |
    ((hmac[offset + 2]! & 0xff) << 8) |
    (hmac[offset + 3]! & 0xff);
  return String(bin % 10 ** DIGITS).padStart(DIGITS, '0');
}

/** Current 6-digit code for the secret. */
export function generateCode(secret: Buffer, atSec = Math.floor(Date.now() / 1000)): string {
  return hotp(secret, counterAt(atSec));
}

/**
 * Verify `code` against `secret`. Accepts ±1 step (30s window) for
 * mild clock skew. Returns the matched counter so the caller can
 * persist `last_counter` and reject replays of the same step.
 */
export function verifyCode(
  secret: Buffer,
  code: string,
  opts: { atSec?: number; lastCounter?: bigint | null } = {},
): { ok: boolean; counter?: bigint } {
  if (!/^\d{6}$/.test(code)) return { ok: false };
  const atSec = opts.atSec ?? Math.floor(Date.now() / 1000);
  const baseCounter = BigInt(Math.floor(atSec / PERIOD_SEC));
  for (const offset of [-1, 0, 1] as const) {
    const counter = baseCounter + BigInt(offset);
    if (counter < 0n) continue;
    if (opts.lastCounter && counter <= opts.lastCounter) continue;
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64BE(counter);
    if (constantTimeEqualString(hotp(secret, buf), code)) {
      return { ok: true, counter };
    }
  }
  return { ok: false };
}

function constantTimeEqualString(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

/** Generate N random recovery codes — single-use bypass of TOTP. */
export function generateRecoveryCodes(n = 10): string[] {
  return Array.from({ length: n }, () => {
    const b = randomBytes(8);
    return base32Encode(b).slice(0, 12).match(/.{1,4}/g)!.join('-');
  });
}
