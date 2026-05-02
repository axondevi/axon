/**
 * Owner-facing CRUD for contact memory.
 *
 * Routes (mounted under /v1/agents — same pattern as ownerWhatsapp):
 *   GET    /v1/agents/:id/contacts                 → list contacts (paginated)
 *   GET    /v1/agents/:id/contacts/:phone          → single contact
 *   PATCH  /v1/agents/:id/contacts/:phone          → update profile/tags/facts
 *   DELETE /v1/agents/:id/contacts/:phone          → forget this contact
 *
 * Auth: requires the agent's owner (apiKeyAuth + ownership check).
 */
import { Hono } from 'hono';
import { eq, and, desc } from 'drizzle-orm';
import { db } from '~/db';
import { agents, contactDocuments } from '~/db/schema';
import { Errors } from '~/lib/errors';
import {
  listContacts,
  getContact,
  getOrCreateMemory,
  updateProfile,
  deleteContact,
  type ContactFact,
} from '~/agents/contact-memory';
import { presignGet, isStorageConfigured } from '~/storage/r2';

export const ownerContacts = new Hono();

// Verify the requester owns this agent.
async function requireOwnedAgent(userId: string, agentId: string) {
  const [a] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.ownerId, userId)))
    .limit(1);
  if (!a) throw Errors.notFound('Agent');
  return a;
}

// ─── List ─────────────────────────────────────────────────
ownerContacts.get('/:id/contacts', async (c) => {
  const user = c.get('user') as { id: string };
  const agentId = c.req.param('id');
  await requireOwnedAgent(user.id, agentId);

  const limit = Math.min(parseInt(c.req.query('limit') || '50', 10) || 50, 200);
  const offset = Math.max(parseInt(c.req.query('offset') || '0', 10) || 0, 0);
  const rows = await listContacts({ agentId, limit, offset });

  return c.json({
    contacts: rows.map((r) => ({
      phone: r.phone,
      display_name: r.displayName,
      language: r.language,
      formality: r.formality,
      tags: r.tags,
      message_count: r.messageCount,
      first_contact_at: r.firstContactAt,
      last_contact_at: r.lastContactAt,
      facts_count: Array.isArray(r.facts) ? (r.facts as unknown[]).length : 0,
      arc: r.arc ?? null,
    })),
    limit,
    offset,
  });
});

// ─── Get one ──────────────────────────────────────────────
ownerContacts.get('/:id/contacts/:phone', async (c) => {
  const user = c.get('user') as { id: string };
  const agentId = c.req.param('id');
  const phone = c.req.param('phone');
  await requireOwnedAgent(user.id, agentId);

  const m = await getContact(agentId, phone);
  if (!m) throw Errors.notFound('Contact');

  return c.json({
    phone: m.phone,
    display_name: m.displayName,
    language: m.language,
    formality: m.formality,
    tags: m.tags,
    facts: m.facts,
    summary: m.summary,
    message_count: m.messageCount,
    first_contact_at: m.firstContactAt,
    last_contact_at: m.lastContactAt,
    arc: m.arc ?? null,
  });
});

// ─── List documents the contact ever sent ─────────────────────────
//
// Returns docs grouped by doc_type with a fresh presigned URL each call
// (default 1h expiry). The list is the source of truth for the dashboard
// "Documentos do contato" panel: receita / exame / comprovante / etc.
//
// `storage_configured: false` means R2 isn't set up yet — UI can show
// "Configure Cloudflare R2 in env to enable file downloads" instead of
// dead links. Rows still come through (we always insert metadata, even
// when upload fails).
ownerContacts.get('/:id/contacts/:phone/documents', async (c) => {
  const user = c.get('user') as { id: string };
  const agentId = c.req.param('id');
  const phone = c.req.param('phone');
  await requireOwnedAgent(user.id, agentId);

  const memory = await getContact(agentId, phone);
  if (!memory) {
    // Contact doesn't exist yet → no docs, return empty list (don't 404
    // — the dashboard wants to render "0 docs" cleanly without an error
    // banner for new contacts).
    return c.json({
      documents: [],
      storage_configured: isStorageConfigured(),
    });
  }

  const rows = await db
    .select()
    .from(contactDocuments)
    .where(
      and(
        eq(contactDocuments.contactMemoryId, memory.id),
        eq(contactDocuments.agentId, agentId),
      ),
    )
    .orderBy(desc(contactDocuments.uploadedAt))
    .limit(200);

  const limitDefault = 3600;
  const documents = rows.map((r) => {
    let downloadUrl: string | null = null;
    if (r.storageKey) {
      const signed = presignGet({ key: r.storageKey, expiresIn: limitDefault });
      if (signed.ok) downloadUrl = signed.url || null;
    }
    return {
      id: r.id,
      filename: r.filename,
      mime_type: r.mimeType,
      byte_size: r.byteSize,
      doc_type: r.docType,
      summary: r.summary,
      caller_caption: r.callerCaption,
      uploaded_at: r.uploadedAt,
      download_url: downloadUrl,
      download_expires_in_seconds: downloadUrl ? limitDefault : null,
    };
  });

  return c.json({
    documents,
    storage_configured: isStorageConfigured(),
  });
});

// ─── Update ───────────────────────────────────────────────
ownerContacts.patch('/:id/contacts/:phone', async (c) => {
  const user = c.get('user') as { id: string };
  const agentId = c.req.param('id');
  const phone = c.req.param('phone');
  await requireOwnedAgent(user.id, agentId);

  const body = await c.req.json().catch(() => ({} as any));

  // Validate optional fields. Only patch what was provided.
  const updates: Parameters<typeof updateProfile>[2] = {};

  if ('display_name' in body) {
    if (body.display_name !== null && typeof body.display_name !== 'string') {
      return c.json({ error: 'bad_request', message: 'display_name must be string or null' }, 400);
    }
    updates.displayName = body.display_name;
  }

  if ('language' in body) {
    const validLangs = ['pt-br', 'en', 'es', 'fr', 'de'];
    if (typeof body.language !== 'string' || !validLangs.includes(body.language)) {
      return c.json({ error: 'bad_request', message: 'language must be one of: ' + validLangs.join(',') }, 400);
    }
    updates.language = body.language;
  }

  if ('formality' in body) {
    if (!['formal', 'informal', 'auto'].includes(body.formality)) {
      return c.json({ error: 'bad_request', message: "formality must be 'formal' | 'informal' | 'auto'" }, 400);
    }
    updates.formality = body.formality;
  }

  if ('tags' in body) {
    if (!Array.isArray(body.tags)) {
      return c.json({ error: 'bad_request', message: 'tags must be array of strings' }, 400);
    }
    updates.tags = body.tags.map((t: unknown) => String(t));
  }

  if ('facts' in body) {
    if (!Array.isArray(body.facts)) {
      return c.json({ error: 'bad_request', message: 'facts must be array of {key,value}' }, 400);
    }
    const facts: ContactFact[] = [];
    for (const raw of body.facts) {
      if (!raw || typeof raw !== 'object') continue;
      const key = String((raw as any).key || '').trim();
      const value = String((raw as any).value || '').trim();
      if (!key || !value) continue;
      facts.push({
        key,
        value,
        confidence: 1.0,
        extracted_at: new Date().toISOString(),
        source: 'manual',
      });
    }
    updates.facts = facts;
  }

  if ('summary' in body) {
    if (body.summary !== null && typeof body.summary !== 'string') {
      return c.json({ error: 'bad_request', message: 'summary must be string or null' }, 400);
    }
    updates.summary = body.summary;
  }

  if (Object.keys(updates).length === 0) {
    return c.json({ error: 'bad_request', message: 'no fields to update' }, 400);
  }

  // Upsert: lazy-create the row if owner is editing before any inbound msg.
  // Lets the operator pre-populate a customer's profile.
  await getOrCreateMemory(agentId, phone);

  const updated = await updateProfile(agentId, phone, updates);
  if (!updated) throw Errors.notFound('Contact');

  return c.json({
    ok: true,
    contact: {
      phone: updated.phone,
      display_name: updated.displayName,
      language: updated.language,
      formality: updated.formality,
      tags: updated.tags,
      facts: updated.facts,
      summary: updated.summary,
      message_count: updated.messageCount,
    },
  });
});

// ─── Delete (forget) ──────────────────────────────────────
ownerContacts.delete('/:id/contacts/:phone', async (c) => {
  const user = c.get('user') as { id: string };
  const agentId = c.req.param('id');
  const phone = c.req.param('phone');
  await requireOwnedAgent(user.id, agentId);

  const ok = await deleteContact(agentId, phone);
  if (!ok) throw Errors.notFound('Contact');

  return c.json({ ok: true });
});
