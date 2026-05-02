/**
 * Document Vault — silent persistence of customer-sent attachments.
 *
 * Why this exists:
 * Today every photo / PDF a contact sends gets described inline (Vision /
 * Gemini) and dropped after the LLM call. The owner has no way to see
 * "all exames that customer X ever sent" without scrolling the chat. The
 * vault saves the BYTES to R2, classifies the doc_type via a small LLM,
 * and indexes it on contact_documents — feeding a per-contact dashboard
 * panel grouped by type.
 *
 * The customer never sees this happen — same conversation, same agent
 * reply. Saving runs fire-and-forget after the reply is dispatched, so
 * upload latency or classifier failure can't degrade the chat experience.
 *
 * No-op when SUPABASE_STORAGE_* envs aren't configured — we still skip-log so ops can
 * see why uploads are missing in the dashboard.
 */
import { db } from '~/db';
import { contactDocuments } from '~/db/schema';
import { putObject } from '~/storage/supabase-storage';
import { classifyDocument, type DocType } from '~/agents/doc-classifier';
import { log } from '~/lib/logger';
import { randomUUID } from 'node:crypto';

export interface SaveDocumentResult {
  ok: boolean;
  documentId?: string;
  storageKey?: string;
  docType?: DocType;
  /** True when storage isn't configured — caller should keep behaving normally. */
  skippedNoStorage?: boolean;
  error?: string;
}

/**
 * Map a MIME type to a sensible filename extension. Used to build the R2
 * storage key suffix so signed-URL downloads land with a usable extension
 * (browsers / native clients pick their renderer based on extension).
 */
function extensionForMime(mimeType: string, fallbackFilename?: string): string {
  // Honor the original filename's extension if it looks reasonable —
  // preserves rare formats (e.g. .heic, .webp) we don't have an explicit
  // mapping for.
  if (fallbackFilename) {
    const m = fallbackFilename.match(/\.([a-z0-9]{2,5})$/i);
    if (m) return m[1].toLowerCase();
  }
  const map: Record<string, string> = {
    'application/pdf': 'pdf',
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/pjpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/heic': 'heic',
    'image/heif': 'heif',
    'image/gif': 'gif',
  };
  return map[mimeType.toLowerCase()] || 'bin';
}

/**
 * Persist a customer-sent attachment to R2 + the contact_documents index.
 *
 * Caller has already extracted text (Vision description for images, Gemini
 * multimodal text for PDFs) so we don't re-do the extraction here — keeps
 * this function fast and avoids double-charging Gemini.
 *
 * Steps:
 *   1. Build storage key under documents/<agent>/<contact>/<doc>.<ext>
 *   2. Upload bytes to R2
 *   3. Classify doc_type via Groq (~200ms)
 *   4. Insert row
 *
 * Failure modes:
 *   - No R2 envs → skip upload, skip insert, return ok:false skippedNoStorage
 *   - R2 upload fails → still insert row with empty storage_key + log warn
 *     so dashboard shows "extraction available, file lost" instead of
 *     pretending nothing happened
 *   - Classifier fails → fall back to docType='outro' with extracted-text
 *     trimmed as summary
 */
export async function saveContactDocument(opts: {
  agentId: string;
  contactMemoryId: string;
  bytes: Uint8Array;
  mimeType: string;
  filename?: string;
  callerCaption?: string;
  /** Already-extracted text (Vision description / PDF transcript). */
  extractedText: string;
}): Promise<SaveDocumentResult> {
  const documentId = randomUUID();
  const ext = extensionForMime(opts.mimeType, opts.filename);
  const storageKey = `documents/${opts.agentId}/${opts.contactMemoryId}/${documentId}.${ext}`;

  // 1. Upload to R2 (best-effort — zero-cost mode runs without R2).
  // When R2 isn't configured, we still want the row indexed so the
  // owner's dashboard shows the doc with its classification + extracted
  // text (the original file stays in the customer's WhatsApp thread,
  // not lost — just not centralized).
  const upload = await putObject({
    key: storageKey,
    bytes: opts.bytes,
    mimeType: opts.mimeType,
  });

  // 2. Classify (independent of upload outcome — we still index the doc
  // even if R2 hiccups, so the extracted text isn't lost).
  const classification = await classifyDocument({
    extractedText: opts.extractedText,
    mimeType: opts.mimeType,
    filename: opts.filename,
    callerCaption: opts.callerCaption,
  });

  // 3. Insert row. Use empty string for storage_key on upload failure so
  // the column NOT NULL constraint stays satisfied; UI checks for empty
  // and disables the download link.
  try {
    await db.insert(contactDocuments).values({
      id: documentId,
      contactMemoryId: opts.contactMemoryId,
      agentId: opts.agentId,
      filename: opts.filename?.slice(0, 200) || null,
      mimeType: opts.mimeType,
      byteSize: opts.bytes.length,
      storageKey: upload.ok ? storageKey : '',
      docType: classification.docType,
      extractedText: opts.extractedText.slice(0, 10000),
      summary: classification.summary,
      callerCaption: opts.callerCaption?.slice(0, 500) || null,
    });
  } catch (err: any) {
    log.warn('document_vault.insert_failed', {
      error: err?.message || String(err),
      agent_id: opts.agentId,
    });
    return { ok: false, error: err?.message || String(err) };
  }

  log.info('document_vault.saved', {
    document_id: documentId,
    doc_type: classification.docType,
    bytes: opts.bytes.length,
    mime: opts.mimeType,
    upload_ok: upload.ok,
  });

  void import('~/lib/metrics').then(({ bumpCounter }) => {
    bumpCounter('axon_document_vault_saved_total', { doc_type: classification.docType });
  });

  return {
    ok: true,
    documentId,
    storageKey: upload.ok ? storageKey : undefined,
    docType: classification.docType,
  };
}

/**
 * Persist a PDF the AGENT generated and sent to a customer.
 *
 * Distinct from saveContactDocument (which classifies inbound media via
 * an LLM): outbound docs come with type + title + excerpt already known,
 * so we skip the classifier and write directly. Same R2 / metadata-only
 * fallback rules apply: row is always inserted (with empty storage_key
 * if upload fails), so the dashboard timeline is complete even when
 * Storage hiccups.
 *
 * Storage key namespace: documents/<agent>/<contact>/generated/<id>.pdf
 * — separate "generated" prefix so ops can spot/clean outbound vs inbound
 * with a quick prefix list.
 */
export async function saveOutboundDocument(opts: {
  agentId: string;
  contactMemoryId: string;
  bytes: Uint8Array | Buffer;
  mimeType: string;
  filename: string;
  title: string;
  /** Caller-provided category (matches the doc_type_hint enum). */
  docType: string;
  /** Caller-provided one-line summary derived from the body. */
  excerpt: string;
}): Promise<SaveDocumentResult> {
  const documentId = randomUUID();
  const ext = extensionForMime(opts.mimeType, opts.filename);
  const storageKey = `documents/${opts.agentId}/${opts.contactMemoryId}/generated/${documentId}.${ext}`;
  const bytesUint =
    opts.bytes instanceof Uint8Array ? opts.bytes : new Uint8Array(opts.bytes);

  const upload = await putObject({
    key: storageKey,
    bytes: bytesUint,
    mimeType: opts.mimeType,
  });

  const summary =
    opts.title.trim().slice(0, 80) +
    (opts.excerpt ? ` — ${opts.excerpt.replace(/\s+/g, ' ').slice(0, 120)}` : '');

  try {
    await db.insert(contactDocuments).values({
      id: documentId,
      contactMemoryId: opts.contactMemoryId,
      agentId: opts.agentId,
      filename: opts.filename.slice(0, 200),
      mimeType: opts.mimeType,
      byteSize: bytesUint.length,
      storageKey: upload.ok ? storageKey : '',
      docType: opts.docType,
      direction: 'outbound',
      extractedText: opts.excerpt.slice(0, 10000),
      summary: summary.slice(0, 200),
      callerCaption: null,
    });
  } catch (err: any) {
    log.warn('document_vault.outbound_insert_failed', {
      error: err?.message || String(err),
      agent_id: opts.agentId,
    });
    return { ok: false, error: err?.message || String(err) };
  }

  log.info('document_vault.outbound_saved', {
    document_id: documentId,
    doc_type: opts.docType,
    bytes: bytesUint.length,
    upload_ok: upload.ok,
  });

  void import('~/lib/metrics').then(({ bumpCounter }) => {
    bumpCounter('axon_document_vault_outbound_total', { doc_type: opts.docType });
  });

  return {
    ok: true,
    documentId,
    storageKey: upload.ok ? storageKey : undefined,
  };
}
