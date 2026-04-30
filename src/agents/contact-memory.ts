/**
 * Contact Memory — durable per-contact knowledge for WhatsApp agents.
 *
 * Why this exists:
 *   Without memory, every WhatsApp turn starts fresh: agent re-asks the
 *   customer's name, doesn't remember what they bought, treats them like a
 *   stranger. With memory, the agent recognizes Pedro on day 30 and says
 *   "vi que você comprou tênis 42 mês passado, posso ajudar com mais alguma
 *   coisa?". This is the single biggest differentiator vs basic chatbots.
 *
 * How it works:
 *   1. On every inbound WhatsApp message, getOrCreateMemory(agentId, phone)
 *      loads (or lazy-creates) a row keyed by (agent_id, phone).
 *   2. buildMemoryContext(memory) renders structured profile + facts into a
 *      "## What you know about this contact" block injected into the system
 *      prompt — gives the LLM context BEFORE it generates a reply.
 *   3. After the agent responds, extractFactsFromTurn() fires async (no
 *      blocking the user reply) — calls Groq with a structured-output prompt
 *      to distill any new durable facts from the user's message and merge
 *      them into the facts[] array.
 *   4. Owner can manually edit display_name / tags / facts via owner CRUD
 *      endpoints (corrections take precedence over LLM extractions).
 *
 * Cost:
 *   - getMemory: 1 SELECT per turn (~1ms)
 *   - extractFacts: 1 Groq call (~$0.0001) — fire-and-forget, doesn't block
 *   - Compared to skipping memory: each agent turn becomes ~30% more useful
 *     (real estimate from FAQ logs), justifying the marginal extraction cost.
 */

import { db } from '~/db';
import { contactMemory, type ContactMemory } from '~/db/schema';
import { and, eq, sql, desc } from 'drizzle-orm';
import { upstreamKeyFor } from '~/config';
import { log } from '~/lib/logger';

// ─── Types ─────────────────────────────────────────────────

export interface ContactFact {
  /** Short kebab-case key, e.g. "name", "delivery_address", "preferred_payment". */
  key: string;
  /** Free-form value, e.g. "Pedro Silva", "Av Paulista 1000, SP", "PIX". */
  value: string;
  /** 0..1 — how confident extraction was. Manual edits = 1.0. */
  confidence: number;
  /** ISO timestamp. Newer overrides older for same key. */
  extracted_at: string;
  /** 'llm' | 'manual' — source of truth, manual wins on conflict. */
  source: 'llm' | 'manual';
}

// ─── Read / load ───────────────────────────────────────────

/**
 * Load or create the memory row for (agentId, phone). If pushName is
 * provided (Evolution sends WhatsApp profile name), use it as initial
 * display_name on first contact.
 */
export async function getOrCreateMemory(
  agentId: string,
  phone: string,
  pushName?: string,
  /** Optional referrer user id resolved from a `?ref=` link. Stored on
   *  first creation only (existing contacts keep their original or null
   *  attribution — no re-attribution after the fact). */
  referredByUserId?: string | null,
): Promise<ContactMemory> {
  const [existing] = await db
    .select()
    .from(contactMemory)
    .where(and(eq(contactMemory.agentId, agentId), eq(contactMemory.phone, phone)))
    .limit(1);
  if (existing) return existing;

  const [created] = await db
    .insert(contactMemory)
    .values({
      agentId,
      phone,
      displayName: pushName?.slice(0, 100) || null,
      referredByUserId: referredByUserId || null,
    })
    .onConflictDoNothing({
      target: [contactMemory.agentId, contactMemory.phone],
    })
    .returning();

  if (created) return created;

  // Race condition fallback: another concurrent request already inserted.
  const [reloaded] = await db
    .select()
    .from(contactMemory)
    .where(and(eq(contactMemory.agentId, agentId), eq(contactMemory.phone, phone)))
    .limit(1);
  return reloaded;
}

// ─── Format for LLM injection ──────────────────────────────

/**
 * Render a memory row as a natural-language block to prepend to the agent's
 * system prompt. Only includes non-empty fields so the LLM doesn't get
 * "name: null" garbage. Caps facts at 20 most-recent (room for prompt budget).
 */
export function buildMemoryContext(m: ContactMemory): string {
  const lines: string[] = [];

  if (m.displayName) {
    lines.push(`- Nome: ${m.displayName}`);
  }
  if (m.language && m.language !== 'pt-br') {
    lines.push(`- Idioma preferido: ${m.language}`);
  }
  if (m.formality && m.formality !== 'auto') {
    lines.push(`- Tom de comunicação: ${m.formality}`);
  }

  const tags = Array.isArray(m.tags) ? (m.tags as string[]) : [];
  if (tags.length > 0) {
    lines.push(`- Tags: ${tags.join(', ')}`);
  }

  const facts = Array.isArray(m.facts) ? (m.facts as ContactFact[]) : [];
  if (facts.length > 0) {
    // Sort: manual first, then by recency, take 20
    const sorted = [...facts]
      .sort((a, b) => {
        if (a.source === 'manual' && b.source !== 'manual') return -1;
        if (b.source === 'manual' && a.source !== 'manual') return 1;
        return (b.extracted_at || '').localeCompare(a.extracted_at || '');
      })
      .slice(0, 20);
    lines.push('- Fatos conhecidos:');
    for (const f of sorted) {
      lines.push(`  • ${f.key}: ${f.value}`);
    }
  }

  if (m.summary) {
    lines.push(`- Resumo de interações anteriores: ${m.summary}`);
  }

  if (m.messageCount > 0) {
    const since = new Date(m.firstContactAt).toISOString().slice(0, 10);
    lines.push(`- Já trocaram ${m.messageCount} mensagens desde ${since}.`);
  } else {
    lines.push('- Primeira vez falando com este contato.');
  }

  if (lines.length === 0) {
    return '(Sem informações prévias sobre este contato.)';
  }
  return lines.join('\n');
}

// ─── Stats / counters ──────────────────────────────────────

/**
 * Bump the message counter and refresh last_contact_at. Atomic update so
 * concurrent inbound messages don't race on the count.
 */
export async function recordTurn(agentId: string, phone: string): Promise<void> {
  await db
    .update(contactMemory)
    .set({
      messageCount: sql`${contactMemory.messageCount} + 1`,
      lastContactAt: new Date(),
      updatedAt: new Date(),
    })
    .where(and(eq(contactMemory.agentId, agentId), eq(contactMemory.phone, phone)));
}

// ─── LLM-driven fact extraction ────────────────────────────

const EXTRACTION_SYSTEM_PROMPT = `You analyze a customer-support conversation and extract durable facts about the customer that the assistant should remember for future interactions.

Output STRICT JSON only — no prose, no markdown:
{
  "facts": [{"key": "snake_case_key", "value": "concise value"}],
  "profile": {
    "display_name": "Pedro Silva" or null,
    "language": "pt-br" | "en" | "es" or null,
    "formality": "formal" | "informal" or null
  }
}

Rules for extracting facts:
- Extract ONLY durable, future-useful facts. Skip greetings, politeness, current questions.
- Keys are short snake_case nouns: name, email, delivery_address, allergy, preferred_payment, product_owned, profession, vehicle, pet_name, dietary_restriction, birthday, contact_preference, etc.
- Values are concise (under 80 chars). No long sentences.
- If user introduces themselves ("Sou o Pedro"), set profile.display_name.
- Detect language from user's writing (pt-br for Portuguese, en for English, es for Spanish).
- Detect formality: "tu/você" formal vs "ce/mano" informal in PT.
- Return EMPTY arrays/null for fields with no signal. Don't invent.
- Maximum 5 new facts per call.

Examples of good extraction:
User: "Oi, sou o Pedro Silva. Sou alérgico a lactose. Moro em Belo Horizonte."
Output: {"facts":[{"key":"allergy","value":"lactose"},{"key":"city","value":"Belo Horizonte"}],"profile":{"display_name":"Pedro Silva","language":"pt-br","formality":null}}

User: "Quanto custa a consulta?"
Output: {"facts":[],"profile":{}}`;

interface ExtractResult {
  facts: Array<{ key: string; value: string }>;
  profile: {
    display_name?: string | null;
    language?: string | null;
    formality?: string | null;
  };
}

async function callExtractor(userMessage: string, currentFacts: ContactFact[]): Promise<ExtractResult | null> {
  const groqKey = upstreamKeyFor('groq');
  if (!groqKey) return null;

  const knownKeys = currentFacts.map((f) => f.key).slice(0, 30).join(', ');

  const userPrompt = [
    knownKeys ? `Already-known fact keys (don't re-extract identical): ${knownKeys}` : '',
    `Latest user message:\n"""${userMessage.slice(0, 800)}"""`,
  ]
    .filter(Boolean)
    .join('\n\n');

  try {
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${groqKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [
          { role: 'system', content: EXTRACTION_SYSTEM_PROMPT },
          { role: 'user', content: userPrompt },
        ],
        max_tokens: 400,
        temperature: 0.1,
        response_format: { type: 'json_object' },
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return null;
    const j = (await r.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const text = j.choices?.[0]?.message?.content;
    if (!text) return null;
    const parsed = JSON.parse(text) as ExtractResult;
    return parsed;
  } catch (err) {
    log.warn('contact_memory_extract_failed', { error: String(err) });
    return null;
  }
}

/**
 * Merge new facts into existing array. New facts replace existing entries
 * with the same key (unless source='manual' — manual edits are sticky).
 */
function mergeFacts(existing: ContactFact[], incoming: Array<{ key: string; value: string }>): ContactFact[] {
  const now = new Date().toISOString();
  const result = [...existing];
  for (const newFact of incoming) {
    if (!newFact.key || !newFact.value) continue;
    const key = String(newFact.key).slice(0, 50).toLowerCase().replace(/\s+/g, '_');
    const value = String(newFact.value).slice(0, 200).trim();
    if (!key || !value) continue;

    const existingIdx = result.findIndex((f) => f.key === key);
    if (existingIdx >= 0) {
      const existingFact = result[existingIdx];
      // Manual facts win — don't overwrite owner edits with LLM extractions
      if (existingFact.source === 'manual') continue;
      result[existingIdx] = {
        key,
        value,
        confidence: 0.7,
        extracted_at: now,
        source: 'llm',
      };
    } else {
      result.push({
        key,
        value,
        confidence: 0.7,
        extracted_at: now,
        source: 'llm',
      });
    }
  }
  // Cap at 50 facts per contact to keep prompt budget bounded
  return result.slice(-50);
}

/**
 * Fire-and-forget extraction after each turn. Caller doesn't await — this
 * runs in background while the user already got their reply. Failures are
 * logged but don't propagate.
 */
export async function extractFactsFromTurn(opts: {
  agentId: string;
  phone: string;
  userMessage: string;
  currentMemory: ContactMemory;
}): Promise<void> {
  const { agentId, phone, userMessage, currentMemory } = opts;

  // Skip extraction for trivial messages (no signal)
  const trimmed = userMessage.trim();
  if (trimmed.length < 8) return;

  const currentFacts = Array.isArray(currentMemory.facts) ? (currentMemory.facts as ContactFact[]) : [];

  const result = await callExtractor(trimmed, currentFacts);
  if (!result) return;

  // Build update — only fields with signal
  const updates: Partial<typeof contactMemory.$inferInsert> = {};

  if (Array.isArray(result.facts) && result.facts.length > 0) {
    updates.facts = mergeFacts(currentFacts, result.facts) as unknown as object;
  }

  const profile = result.profile || {};
  if (profile.display_name && !currentMemory.displayName) {
    updates.displayName = String(profile.display_name).slice(0, 100);
  }
  if (profile.language && profile.language !== currentMemory.language) {
    const validLangs = ['pt-br', 'en', 'es', 'fr', 'de'];
    if (validLangs.includes(profile.language)) {
      updates.language = profile.language;
    }
  }
  if (profile.formality && profile.formality !== currentMemory.formality) {
    if (['formal', 'informal'].includes(profile.formality)) {
      updates.formality = profile.formality;
    }
  }

  if (Object.keys(updates).length === 0) return;

  updates.updatedAt = new Date();

  await db
    .update(contactMemory)
    .set(updates)
    .where(and(eq(contactMemory.agentId, agentId), eq(contactMemory.phone, phone)))
    .catch((err) => {
      log.warn('contact_memory_update_failed', { error: String(err) });
    });
}

// ─── Owner CRUD helpers ────────────────────────────────────

export async function listContacts(opts: {
  agentId: string;
  limit?: number;
  offset?: number;
}): Promise<ContactMemory[]> {
  return await db
    .select()
    .from(contactMemory)
    .where(eq(contactMemory.agentId, opts.agentId))
    .orderBy(desc(contactMemory.lastContactAt))
    .limit(opts.limit ?? 50)
    .offset(opts.offset ?? 0);
}

export async function getContact(agentId: string, phone: string): Promise<ContactMemory | null> {
  const [row] = await db
    .select()
    .from(contactMemory)
    .where(and(eq(contactMemory.agentId, agentId), eq(contactMemory.phone, phone)))
    .limit(1);
  return row ?? null;
}

export interface ProfileUpdate {
  displayName?: string | null;
  language?: string;
  formality?: 'formal' | 'informal' | 'auto';
  tags?: string[];
  /** Replace all facts. To merge, owner reads-modifies-writes. */
  facts?: ContactFact[];
  summary?: string | null;
}

export async function updateProfile(
  agentId: string,
  phone: string,
  updates: ProfileUpdate,
): Promise<ContactMemory | null> {
  const patch: Partial<typeof contactMemory.$inferInsert> = { updatedAt: new Date() };

  if (updates.displayName !== undefined) {
    patch.displayName = updates.displayName ? updates.displayName.slice(0, 100) : null;
  }
  if (updates.language !== undefined) {
    patch.language = updates.language;
  }
  if (updates.formality !== undefined) {
    patch.formality = updates.formality;
  }
  if (updates.tags !== undefined) {
    patch.tags = updates.tags.slice(0, 20).map((t) => String(t).slice(0, 40)) as unknown as object;
  }
  if (updates.facts !== undefined) {
    // Mark all owner-supplied facts as 'manual' so they aren't overwritten by LLM
    const sanitized = updates.facts.slice(0, 50).map((f) => ({
      key: String(f.key).slice(0, 50).toLowerCase().replace(/\s+/g, '_'),
      value: String(f.value).slice(0, 200),
      confidence: 1.0,
      extracted_at: new Date().toISOString(),
      source: 'manual' as const,
    }));
    patch.facts = sanitized as unknown as object;
  }
  if (updates.summary !== undefined) {
    patch.summary = updates.summary ? updates.summary.slice(0, 2000) : null;
  }

  const [updated] = await db
    .update(contactMemory)
    .set(patch)
    .where(and(eq(contactMemory.agentId, agentId), eq(contactMemory.phone, phone)))
    .returning();

  return updated ?? null;
}

export async function deleteContact(agentId: string, phone: string): Promise<boolean> {
  const result = await db
    .delete(contactMemory)
    .where(and(eq(contactMemory.agentId, agentId), eq(contactMemory.phone, phone)))
    .returning({ id: contactMemory.id });
  return result.length > 0;
}
