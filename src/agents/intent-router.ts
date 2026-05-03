/**
 * Intent classifier — figures out whether an inbound conversation is
 * sales, personal/support, or generic. Drives smart routing: a single
 * "front door" agent (e.g. Camila) classifies the customer's first message
 * and dispatches the rest of the chat to a specialized agent (Atendente
 * E-commerce for sales, Tia Zélia for personal queries, etc).
 *
 * Why not just let one big system prompt handle everything? Because mixing
 * sales and care contexts in a single LLM call produces drift — the model
 * oscillates between "Estou procurando para um presente?" (sales) and
 * "Você precisa marcar consulta para sua irmã?" (care) on the same turn.
 * Specialized agents per context have tighter prompts, voices, and tool
 * sets — so each one shines in its lane.
 *
 * The classifier itself is a tiny, fast Groq call (~300ms, ~$0.0001 per
 * turn). We use llama-3.1-8b-instant — overkill is wasted here, the task
 * is single-token classification.
 */
import { upstreamKeyFor } from '~/config';
import { db } from '~/db';
import { agents } from '~/db/schema';
import { eq } from 'drizzle-orm';

export type RouteIntent = 'sales' | 'personal' | 'support' | 'unknown';

export interface RoutesTo {
  sales?: string;
  personal?: string;
  support?: string;
}

const CLASSIFIER_PROMPT = `Você é um classificador de intenção de mensagens de WhatsApp.

Receba a mensagem do cliente e responda com UMA palavra apenas, sem pontuação:

- VENDA — cliente está procurando comprar, perguntando preço, produto, "quanto custa", "tem disponível", presente, frete, formas de pagamento, busca de produto/serviço pago.
- PESSOAL — cliente está pedindo conselho, ajuda emocional, conversa informal, dúvida sobre saúde/vida/família, busca apoio ou bate-papo. Nada relacionado a comprar.
- SUPORTE — cliente já é cliente e tem problema: "meu pedido não chegou", "produto com defeito", "não consigo acessar", reclamação, ajuda técnica.
- DESCONHECIDO — não dá pra saber pelo conteúdo (mensagem genérica tipo "oi", "boa tarde", "tudo bem?", emoji só).

Se a mensagem mistura, escolha o que predomina. Se for cumprimento puro sem contexto, responda DESCONHECIDO.

Responda APENAS uma das quatro palavras, em maiúsculas, sem outras palavras nem pontuação.`;

/**
 * Classify a single user message into one of four intents.
 *
 * Returns 'unknown' when the call fails or the model returns garbage —
 * caller should treat unknown as "keep the router agent active" rather
 * than triggering a re-route on every turn.
 */
export async function classifyIntent(message: string): Promise<RouteIntent> {
  const trimmed = message.trim();
  if (trimmed.length < 2) return 'unknown';

  const groqKey = upstreamKeyFor('groq');
  if (!groqKey) return 'unknown';

  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + groqKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        // 8b-instant is plenty for single-word classification — burns ~300ms,
        // saves us picking up an LLM that might over-explain the answer.
        model: 'llama-3.1-8b-instant',
        messages: [
          { role: 'system', content: CLASSIFIER_PROMPT },
          { role: 'user', content: trimmed.slice(0, 1500) },
        ],
        max_tokens: 4,
        temperature: 0,
      }),
    });
    if (!res.ok) return 'unknown';
    const json: any = await res.json().catch(() => null);
    const raw = String(json?.choices?.[0]?.message?.content || '').trim().toUpperCase();
    // Only the first "word" — the model occasionally adds explanation despite
    // the system prompt asking for a single word.
    const word = raw.replace(/[^A-ZÇÃÕÁÉÍÓÚ]/g, '').slice(0, 14);
    if (word.startsWith('VENDA') || word.startsWith('SALES')) return 'sales';
    if (word.startsWith('PESSOAL') || word.startsWith('PERSONAL')) return 'personal';
    if (word.startsWith('SUPORTE') || word.startsWith('SUPPORT')) return 'support';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Pick the agent ID to use for this intent, given the router agent's
 * `routes_to` map. Falls back to null when:
 *   - intent is 'unknown'
 *   - the routes_to entry for that intent is missing or invalid
 * Caller should keep the original (router) agent active when this returns null.
 */
export function pickRoutedAgentId(routes: RoutesTo | null | undefined, intent: RouteIntent): string | null {
  if (!routes) return null;
  if (intent === 'sales' && routes.sales) return routes.sales;
  if (intent === 'personal' && routes.personal) return routes.personal;
  if (intent === 'support' && routes.support) return routes.support;
  return null;
}

/**
 * Load an agent by id, validating it belongs to the same owner as the
 * caller (cheap defense against a misconfigured routes_to pointing at
 * someone else's agent — would leak between accounts otherwise) AND
 * that the agent is in a routable state (not paused, not deleted, owner
 * not deleted). Returns null on any miss; logs the reason so a broken
 * routes_to config is debuggable from the operator's logs instead of
 * silently degrading to fallback.
 */
export async function loadRoutedAgent(opts: {
  agentId: string;
  ownerId: string;
}): Promise<typeof agents.$inferSelect | null> {
  const { log } = await import('~/lib/logger');
  const [a] = await db
    .select()
    .from(agents)
    .where(eq(agents.id, opts.agentId))
    .limit(1);
  if (!a) {
    log.warn('routing.target_missing', { target_agent_id: opts.agentId, owner_id: opts.ownerId });
    return null;
  }
  if (a.ownerId !== opts.ownerId) {
    log.warn('routing.cross_owner_refused', { target_agent_id: opts.agentId, target_owner: a.ownerId, caller_owner: opts.ownerId });
    return null;
  }
  if (!a.public) {
    log.warn('routing.target_disabled', { target_agent_id: opts.agentId });
    return null;
  }
  if (a.pausedAt) {
    log.warn('routing.target_paused', { target_agent_id: opts.agentId, paused_since: a.pausedAt });
    return null;
  }
  // Confirm the owner account itself is still active. If the operator
  // deleted their account, agents cascade-delete via FK, so a missing
  // user usually means the agent already vanished too — but soft-delete
  // (deleted_at) is also possible and that's where we'd leak otherwise.
  const { users } = await import('~/db/schema');
  const [owner] = await db.select().from(users).where(eq(users.id, opts.ownerId)).limit(1);
  if (!owner || owner.deletedAt) {
    log.warn('routing.owner_deleted', { target_agent_id: opts.agentId, owner_id: opts.ownerId });
    return null;
  }
  return a;
}
