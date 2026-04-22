import { createHash, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { env } from '~/config';

// ─── API key generation / hashing ─────────────────────
export function generateApiKey(): string {
  // ax_live_<48 hex chars>
  return `ax_live_${randomBytes(24).toString('hex')}`;
}

export function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

// ─── AES-256-GCM for upstream keys at rest ────────────
function getKey(): Buffer {
  const raw = env.MASTER_ENCRYPTION_KEY;
  // Accept hex (64 chars) or raw string; derive 32 bytes via sha256
  return createHash('sha256').update(raw).digest();
}

export function encrypt(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', getKey(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('hex')}`;
}

export function decrypt(payload: string): string {
  const [ivHex, tagHex, dataHex] = payload.split(':');
  if (!ivHex || !tagHex || !dataHex) {
    throw new Error('Invalid ciphertext');
  }
  const decipher = createDecipheriv('aes-256-gcm', getKey(), Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  const dec = Buffer.concat([
    decipher.update(Buffer.from(dataHex, 'hex')),
    decipher.final(),
  ]);
  return dec.toString('utf8');
}
