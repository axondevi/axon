/**
 * Cloudflare R2 storage wrapper.
 *
 * Built on Bun's native S3 client (Bun.S3Client) — R2 is S3-compatible so
 * the same API works with `endpoint = https://<account>.r2.cloudflarestorage.com`.
 * Saves the heavy @aws-sdk/client-s3 dependency since we already run on Bun.
 *
 * Used for: customer-uploaded documents (PDF, image) sent over WhatsApp.
 * Each object key follows `documents/<agent_id>/<contact_id>/<doc_id>.<ext>`
 * for natural namespace isolation per (agent, contact) and easy bulk-delete
 * if an agent or contact is removed.
 *
 * No-op silent mode: when R2_* envs are unset (dev / customer not yet
 * configured), put() returns ok:false skipped:true and the caller falls
 * through to text-only persistence. Production must have envs set.
 *
 * Required envs:
 *   R2_ACCOUNT_ID         — Cloudflare account id (UUID-ish)
 *   R2_ACCESS_KEY_ID      — R2 API token access key
 *   R2_SECRET_ACCESS_KEY  — R2 API token secret
 *   R2_BUCKET             — bucket name (default: axon-documents)
 */
import { S3Client } from 'bun';
import { log } from '~/lib/logger';

let cachedClient: S3Client | null = null;
let cachedBucket: string | null = null;

/**
 * Lazily build the S3Client from envs. Returns null when any required env
 * is missing — caller must handle this gracefully (skip upload, persist
 * text-only). We re-check on every call so a config change after process
 * start (Render redeploy) takes effect on the next request.
 */
function getClient(): { client: S3Client; bucket: string } | null {
  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  const bucket = process.env.R2_BUCKET || 'axon-documents';
  if (!accountId || !accessKeyId || !secretAccessKey) return null;

  if (cachedClient && cachedBucket === bucket) {
    return { client: cachedClient, bucket };
  }
  cachedClient = new S3Client({
    accessKeyId,
    secretAccessKey,
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    bucket,
    region: 'auto',
  });
  cachedBucket = bucket;
  return { client: cachedClient, bucket };
}

export interface PutResult {
  ok: boolean;
  /** True when no R2 envs configured — caller should fall through gracefully. */
  skipped?: boolean;
  storageKey?: string;
  error?: string;
}

/**
 * Upload bytes to R2 under the given key. The key is caller-controlled so
 * the document-vault layer can build a stable namespace per (agent, contact).
 *
 * Sets Content-Type from `mimeType` so signed-URL downloads render correctly
 * in the browser (e.g. PDF inline preview, image inline render).
 */
export async function putObject(opts: {
  key: string;
  bytes: Uint8Array | ArrayBuffer | Buffer;
  mimeType: string;
}): Promise<PutResult> {
  const handle = getClient();
  if (!handle) {
    log.info('storage.r2.skipped', { reason: 'no_envs' });
    return { ok: false, skipped: true };
  }
  try {
    await handle.client.write(opts.key, opts.bytes as any, { type: opts.mimeType });
    return { ok: true, storageKey: opts.key };
  } catch (err: any) {
    log.warn('storage.r2.put_failed', {
      key: opts.key,
      error: err?.message || String(err),
    });
    return { ok: false, error: err?.message || String(err) };
  }
}

export interface PresignResult {
  ok: boolean;
  url?: string;
  error?: string;
}

/**
 * Generate a presigned GET URL for a stored object. Used by the owner
 * dashboard so the browser can download/preview documents WITHOUT exposing
 * R2 credentials. Default expiry 1h — long enough for a tab session,
 * short enough that a leaked URL in a screenshot can't be replayed forever.
 *
 * Returns a per-request URL; do NOT cache across users — one signed URL is
 * one capability.
 */
export function presignGet(opts: {
  key: string;
  /** Seconds until expiry. Default 3600. Capped at 7 days by S3/R2. */
  expiresIn?: number;
}): PresignResult {
  const handle = getClient();
  if (!handle) return { ok: false, error: 'r2 not configured' };
  try {
    const url = handle.client.presign(opts.key, {
      expiresIn: opts.expiresIn ?? 3600,
      method: 'GET',
    });
    return { ok: true, url };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
}

/**
 * Best-effort delete for cleanup paths (agent disconnected, doc removed
 * by owner). Silent failure is tolerated — orphan objects waste storage
 * but don't break anything else.
 */
export async function deleteObject(opts: { key: string }): Promise<{ ok: boolean; error?: string }> {
  const handle = getClient();
  if (!handle) return { ok: false, error: 'r2 not configured' };
  try {
    await handle.client.delete(opts.key);
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
}

/**
 * True iff R2 is configured. Useful for dashboard surfacing — when not
 * configured, hide the "Documentos" section instead of showing empty.
 */
export function isStorageConfigured(): boolean {
  return getClient() !== null;
}
