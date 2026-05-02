/**
 * Supabase Storage wrapper (S3-compatible mode).
 *
 * Built on Bun's native S3 client (Bun.S3Client) — Supabase Storage exposes
 * an S3-compatible endpoint at `https://<project>.supabase.co/storage/v1/s3`,
 * so the same code path works without a custom SDK. Same wrapper would
 * point at any other S3-compat storage (R2, MinIO, Backblaze B2) by
 * swapping the endpoint env.
 *
 * Used for: customer-uploaded documents (PDF, image) sent over WhatsApp.
 * Each object key follows `documents/<agent_id>/<contact_id>/<doc_id>.<ext>`
 * for natural namespace isolation per (agent, contact) and easy bulk-delete
 * if an agent or contact is removed.
 *
 * Why Supabase Storage:
 *   - Free tier 1GB without requiring a credit card on file.
 *   - Same Supabase project pattern several Axon customers already use.
 *   - Native signed URLs via the S3 API.
 *
 * No-op silent mode: when the SUPABASE_STORAGE_* envs are unset (dev /
 * customer not yet configured), put() returns ok:false skipped:true and
 * the caller falls through gracefully — vault still indexes the doc on
 * contact_documents with an empty storage_key, just no download URL.
 *
 * Required envs:
 *   SUPABASE_STORAGE_ENDPOINT       — full S3 endpoint, e.g.
 *                                     https://abcd1234.supabase.co/storage/v1/s3
 *   SUPABASE_STORAGE_ACCESS_KEY_ID  — S3 access key from Supabase dashboard
 *                                     (Project Settings → Storage → S3 Conn)
 *   SUPABASE_STORAGE_SECRET_KEY     — paired secret key
 *   SUPABASE_STORAGE_BUCKET         — bucket name (default: axon-documents)
 *   SUPABASE_STORAGE_REGION         — region (default: us-east-1; change to
 *                                     match your project's region if needed)
 */
import { S3Client } from 'bun';
import { log } from '~/lib/logger';

let cachedClient: S3Client | null = null;
let cachedBucket: string | null = null;
let cachedEndpoint: string | null = null;

/**
 * Lazily build the S3Client from envs. Returns null when any required env
 * is missing — caller must handle this gracefully (skip upload, persist
 * metadata-only). We re-check on every call so a config change after
 * process start (Render redeploy) takes effect on the next request.
 *
 * Cache invalidates on endpoint / bucket change so the same client isn't
 * accidentally reused after a config edit.
 */
function getClient(): { client: S3Client; bucket: string } | null {
  const endpoint = process.env.SUPABASE_STORAGE_ENDPOINT;
  const accessKeyId = process.env.SUPABASE_STORAGE_ACCESS_KEY_ID;
  const secretAccessKey = process.env.SUPABASE_STORAGE_SECRET_KEY;
  const bucket = process.env.SUPABASE_STORAGE_BUCKET || 'axon-documents';
  const region = process.env.SUPABASE_STORAGE_REGION || 'us-east-1';
  if (!endpoint || !accessKeyId || !secretAccessKey) return null;

  if (cachedClient && cachedBucket === bucket && cachedEndpoint === endpoint) {
    return { client: cachedClient, bucket };
  }
  cachedClient = new S3Client({
    accessKeyId,
    secretAccessKey,
    endpoint,
    bucket,
    region,
  });
  cachedBucket = bucket;
  cachedEndpoint = endpoint;
  return { client: cachedClient, bucket };
}

export interface PutResult {
  ok: boolean;
  /** True when no storage envs configured — caller should fall through gracefully. */
  skipped?: boolean;
  storageKey?: string;
  error?: string;
}

/**
 * Upload bytes to the bucket under the given key. The key is caller-controlled
 * so the document-vault layer can build a stable namespace per (agent, contact).
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
    log.info('storage.supabase.skipped', { reason: 'no_envs' });
    return { ok: false, skipped: true };
  }
  try {
    await handle.client.write(opts.key, opts.bytes as any, { type: opts.mimeType });
    return { ok: true, storageKey: opts.key };
  } catch (err: any) {
    log.warn('storage.supabase.put_failed', {
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
 * storage credentials. Default expiry 1h — long enough for a tab session,
 * short enough that a leaked URL in a screenshot can't be replayed forever.
 *
 * Returns a per-request URL; do NOT cache across users — one signed URL is
 * one capability.
 */
export function presignGet(opts: {
  key: string;
  /** Seconds until expiry. Default 3600. Capped at 7 days by S3. */
  expiresIn?: number;
}): PresignResult {
  const handle = getClient();
  if (!handle) return { ok: false, error: 'storage not configured' };
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
  if (!handle) return { ok: false, error: 'storage not configured' };
  try {
    await handle.client.delete(opts.key);
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
}

/**
 * True iff Supabase Storage is configured. Useful for dashboard surfacing —
 * when not configured, the UI hides download links / shows a "configure
 * storage" hint instead of broken icons.
 */
export function isStorageConfigured(): boolean {
  return getClient() !== null;
}
