/**
 * Judge layer — async per-turn evaluator + conversation arc.
 *
 * Why this exists:
 *   The "🧠 raciocínio" panel shows the operator WHAT the agent did, but
 *   says nothing about WHETHER it did the right thing. Without a verdict,
 *   the data is just log soup. The judge calls a SEPARATE LLM (different
 *   provider than the one that answered, when possible) with a fixed rubric
 *   that scores the turn 0-100 along a few binary axes plus a list of issues.
 *   Surfaces in the brain UI as a green/yellow/red badge per assistant
 *   bubble + an aggregate "saúde do agente" pill.
 *
 * Why a different provider:
 *   LLMs are biased toward outputs from their own family. Pairing
 *   Groq-llama-3.3 (response) with Gemini-2.5-flash (judge) gives a real
 *   second opinion. When only one provider is configured, the judge falls
 *   back to it — biased verdict is still better than no verdict.
 *
 * Why fire-and-forget:
 *   We persist the assistant message FIRST (so the customer sees the reply
 *   immediately) and then POST a no-op-on-error UPDATE to write meta.eval.
 *   Adds zero latency to the customer reply path. If the judge fails, the
 *   bubble stays unrated — the panel handles missing eval gracefully.
 *
 * Cost:
 *   ~$0.0002 per judged turn (300-token rubric in, 80 tokens out).
 *   Negligible vs the ~$0.001-0.005 the agent itself burns per turn.
 */
import { eq } from 'drizzle-orm';
import { db } from '~/db';
import { agentMessages, contactMemory } from '~/db/schema';
import { upstreamKeyFor } from '~/config';
import { log } from '~/lib/logger';

// ─── Types ─────────────────────────────────────────────────

export interface TurnEval {
  /** 0-100. Composite of the boolean axes + issue penalties. */
  score: number;
  /** Did the agent address what the customer asked? */
  respondeu_pergunta: boolean;
  /** Did the agent invoke the right tools (or skip them when unnecessary)? */
  usou_tools_certas: boolean;
  /** Did the agent honor the business info (prices, hours, etc.) provided? */
  respeitou_business_info: boolean;
  /** Did the agent stay in persona (e.g. Camila, Tia Zélia)? */
  manteve_persona: boolean;
  /** Tone matches the customer's language and formality? */
  tom_adequado: boolean;
  /** Did the agent ask for clarification when the user message was ambiguous? */
  pediu_clarificacao_quando_devia: boolean;
  /** Did the agent invent facts or numbers not in the system prompt / memory? */
  alucinou: boolean;
  /** Short list of specific issues — 0-3 items, each one phrase, PT-BR. */
  issues: string[];
  /** Bucket the score: 'great' | 'ok' | 'ok_com_ressalva' | 'ruim'. */
  veredito: 'great' | 'ok' | 'ok_com_ressalva' | 'ruim';
  /** Provider that ran the judge (for transparency). */
  judged_by?: string;
  /** ISO timestamp when judged. */
  judged_at: string;
}

export interface ConversationArc {
  /** What is the conversation doing? */
  state: 'progressing' | 'stuck' | 'frustrated' | 'closing' | 'resolved';
  /** Short signals that drove the verdict, e.g. "cliente repetiu pergunta 2x". */
  signals: string[];
  /** ISO timestamp. */
  updated_at: string;
  /** Number of contact turns at the moment of evaluation (so we know when to re-eval). */
  turn_count_at_eval: number;
}

// ─── Per-turn rubric ───────────────────────────────────────

const TURN_RUBRIC = `Você é um avaliador rigoroso de respostas de assistentes virtuais em WhatsApp.

Receba o system_prompt, a mensagem do cliente, a resposta do agente, e o trace de execução (quais tools rodaram, custo, etc).
Avalie em PT-BR, retornando APENAS um JSON válido nesta forma exata:

{
  "respondeu_pergunta": boolean,
  "usou_tools_certas": boolean,
  "respeitou_business_info": boolean,
  "manteve_persona": boolean,
  "tom_adequado": boolean,
  "pediu_clarificacao_quando_devia": boolean,
  "alucinou": boolean,
  "issues": ["frase curta", ...]
}

Regras:
- "issues" deve ter no máximo 3 items, cada um em PT-BR, frase curta.
- Não invente issues — só reporte o que efetivamente está errado na resposta.
- Se a resposta foi correta e adequada, "issues" = [].
- "alucinou" = true APENAS se o agente afirmou um fato (preço, horário, endereço) que não estava no system_prompt e não veio de tool result.
- "pediu_clarificacao_quando_devia": true se a mensagem do cliente foi ambígua E o agente pediu clarificação. Se a mensagem foi clara, esse campo deve ser true (não havia clarificação pra pedir).
- Cumprimentos, "oi", "tudo bem?" são clientes pedindo CONVERSA, não pergunta — agente cumprimentar de volta = respondeu_pergunta:true.

Retorne SOMENTE o JSON, nada mais.`;

const ARC_RUBRIC = `Você é um analista de conversas de WhatsApp em PT-BR.

Receba a transcript completa da conversa entre cliente e agente, e classifique o ARCO da conversa.
Retorne APENAS um JSON válido nesta forma:

{
  "state": "progressing" | "stuck" | "frustrated" | "closing" | "resolved",
  "signals": ["frase curta sobre por quê", ...]
}

Significados:
- "progressing": conversa está fluindo, cliente engajado, sem repetições.
- "stuck": cliente repetiu a mesma pergunta 2+ vezes; agente não avançou; loops.
- "frustrated": cliente expressou descontentamento ("não entendi", "esquece", "to perdendo tempo", reclamação).
- "closing": cliente perto de finalizar (pediu pix, agendamento, confirmação) mas ainda não fechou.
- "resolved": cliente confirmou conclusão (pagou, agendou, agradeceu fechando).

"signals" no máximo 3 frases curtas em PT-BR explicando os sinais que justificam o state.

Retorne SOMENTE o JSON, nada mais.`;

// ─── LLM caller (judge picks a different provider than respondeu) ──

interface JudgeCallOpts {
  systemPrompt: string;
  userInput: string;
  /** Avoid using this provider — pick a different one if available. */
  avoidProvider?: string;
  maxTokens?: number;
}

interface JudgeResult {
  text: string;
  provider: string;
}

/**
 * Call a small fast model. Tries Gemini Flash first (cheap, separate
 * family), then Groq llama-3.1-8b-instant, then any configured provider.
 * Skips the provider passed in `avoidProvider` to avoid self-judging bias.
 *
 * Returns null if no provider is reachable — caller treats null as
 * "skip this judgement, leave eval=null". Better than throwing because
 * the assistant message is already persisted and visible to the user.
 */
async function callJudgeLLM(opts: JudgeCallOpts): Promise<JudgeResult | null> {
  const candidates: Array<{ name: string; fn: () => Promise<string> }> = [];

  const geminiKey = upstreamKeyFor('gemini');
  if (geminiKey && opts.avoidProvider !== 'gemini') {
    candidates.push({
      name: 'gemini',
      fn: async () => {
        const res = await fetch(
          'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
          {
            method: 'POST',
            headers: { Authorization: 'Bearer ' + geminiKey, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model: 'gemini-2.5-flash',
              messages: [
                { role: 'system', content: opts.systemPrompt },
                { role: 'user', content: opts.userInput },
              ],
              max_tokens: opts.maxTokens ?? 400,
              temperature: 0.1,
            }),
          },
        );
        if (!res.ok) throw new Error(`gemini ${res.status}`);
        const j: any = await res.json();
        return String(j?.choices?.[0]?.message?.content || '');
      },
    });
  }

  const groqKey = upstreamKeyFor('groq');
  if (groqKey && opts.avoidProvider !== 'groq') {
    candidates.push({
      name: 'groq',
      fn: async () => {
        const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + groqKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'llama-3.1-8b-instant',
            messages: [
              { role: 'system', content: opts.systemPrompt },
              { role: 'user', content: opts.userInput },
            ],
            max_tokens: opts.maxTokens ?? 400,
            temperature: 0.1,
          }),
        });
        if (!res.ok) throw new Error(`groq ${res.status}`);
        const j: any = await res.json();
        return String(j?.choices?.[0]?.message?.content || '');
      },
    });
  }

  // Fallback: avoidProvider has the only key — use it anyway (biased > nothing)
  if (candidates.length === 0) {
    if (geminiKey) {
      candidates.push({
        name: 'gemini',
        fn: async () => {
          const res = await fetch(
            'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
            {
              method: 'POST',
              headers: { Authorization: 'Bearer ' + geminiKey, 'Content-Type': 'application/json' },
              body: JSON.stringify({
                model: 'gemini-2.5-flash',
                messages: [
                  { role: 'system', content: opts.systemPrompt },
                  { role: 'user', content: opts.userInput },
                ],
                max_tokens: opts.maxTokens ?? 400,
                temperature: 0.1,
              }),
            },
          );
          if (!res.ok) throw new Error(`gemini ${res.status}`);
          const j: any = await res.json();
          return String(j?.choices?.[0]?.message?.content || '');
        },
      });
    } else if (groqKey) {
      candidates.push({
        name: 'groq',
        fn: async () => {
          const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: { Authorization: 'Bearer ' + groqKey, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model: 'llama-3.1-8b-instant',
              messages: [
                { role: 'system', content: opts.systemPrompt },
                { role: 'user', content: opts.userInput },
              ],
              max_tokens: opts.maxTokens ?? 400,
              temperature: 0.1,
            }),
          });
          if (!res.ok) throw new Error(`groq ${res.status}`);
          const j: any = await res.json();
          return String(j?.choices?.[0]?.message?.content || '');
        },
      });
    }
  }

  for (const c of candidates) {
    try {
      const text = await c.fn();
      return { text, provider: c.name };
    } catch (err) {
      log.warn?.('judge_llm_fail', { provider: c.name, error: String(err).slice(0, 200) });
    }
  }
  return null;
}

// ─── Score computation ─────────────────────────────────────

/**
 * Convert the boolean axes + issue count into a 0-100 score.
 * Hard penalties (alucinou=true, ignorou business_info) drop the score
 * harder than soft ones (tom inadequado).
 */
function computeScore(
  evalRaw: Omit<TurnEval, 'score' | 'veredito' | 'judged_at' | 'judged_by'>,
): number {
  let score = 100;
  if (!evalRaw.respondeu_pergunta) score -= 30;
  if (!evalRaw.usou_tools_certas) score -= 15;
  if (!evalRaw.respeitou_business_info) score -= 25;
  if (!evalRaw.manteve_persona) score -= 10;
  if (!evalRaw.tom_adequado) score -= 10;
  if (!evalRaw.pediu_clarificacao_quando_devia) score -= 10;
  if (evalRaw.alucinou) score -= 35;
  // Each unclassified issue chips a few more points off.
  score -= Math.min(evalRaw.issues.length * 3, 9);
  return Math.max(0, Math.min(100, score));
}

function bucket(score: number): TurnEval['veredito'] {
  if (score >= 90) return 'great';
  if (score >= 75) return 'ok';
  if (score >= 50) return 'ok_com_ressalva';
  return 'ruim';
}

// ─── Public API: judgeTurn ─────────────────────────────────

interface JudgeTurnOpts {
  /** UUID of the agent_messages row (assistant role) we're judging. */
  messageId: string;
  systemPrompt: string;
  userMessage: string;
  agentReply: string;
  /** Pretty-printed trace of tool calls etc — let the judge see what ran. */
  trace: string;
  /** Provider that produced the agentReply — judge avoids this one. */
  responseProvider?: string;
}

/**
 * Run the per-turn judge and PATCH agent_messages.meta.eval with the
 * verdict. Fire-and-forget from the caller's perspective — never throws.
 */
export async function judgeTurn(opts: JudgeTurnOpts): Promise<void> {
  try {
    const userInput = [
      '## System prompt do agente',
      opts.systemPrompt.slice(0, 4000),
      '',
      '## Mensagem do cliente',
      opts.userMessage.slice(0, 2000),
      '',
      '## Resposta do agente',
      opts.agentReply.slice(0, 2000),
      '',
      '## Trace de execução',
      opts.trace.slice(0, 1500),
    ].join('\n');

    const judgeRes = await callJudgeLLM({
      systemPrompt: TURN_RUBRIC,
      userInput,
      avoidProvider: opts.responseProvider,
      maxTokens: 400,
    });
    if (!judgeRes) return;

    // Strip code fences the judge sometimes wraps the JSON in.
    const cleaned = judgeRes.text
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/```\s*$/, '')
      .trim();

    let parsed: any;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      // Last-ditch: find the first { ... } block.
      const m = cleaned.match(/\{[\s\S]*\}/);
      if (!m) return;
      try {
        parsed = JSON.parse(m[0]);
      } catch {
        return;
      }
    }

    if (!parsed || typeof parsed !== 'object') return;

    const evalRaw = {
      respondeu_pergunta: !!parsed.respondeu_pergunta,
      usou_tools_certas: !!parsed.usou_tools_certas,
      respeitou_business_info: !!parsed.respeitou_business_info,
      manteve_persona: !!parsed.manteve_persona,
      tom_adequado: !!parsed.tom_adequado,
      pediu_clarificacao_quando_devia: !!parsed.pediu_clarificacao_quando_devia,
      alucinou: !!parsed.alucinou,
      issues: Array.isArray(parsed.issues)
        ? parsed.issues.map((s: unknown) => String(s).slice(0, 200)).slice(0, 3)
        : [],
    };

    const score = computeScore(evalRaw);
    const evalDoc: TurnEval = {
      score,
      ...evalRaw,
      veredito: bucket(score),
      judged_by: judgeRes.provider,
      judged_at: new Date().toISOString(),
    };

    // Merge eval into the existing meta JSONB. We use jsonb_set so we don't
    // race with anything else writing to meta on the same row.
    await db.execute(
      (await import('drizzle-orm')).sql`
        UPDATE agent_messages
        SET meta = jsonb_set(
          COALESCE(meta, '{}'::jsonb),
          '{eval}',
          ${JSON.stringify(evalDoc)}::jsonb,
          true
        )
        WHERE id = ${opts.messageId}
      `,
    );
  } catch (err) {
    log.warn?.('judge_turn_fail', { error: String(err).slice(0, 300) });
  }
}

// ─── Public API: judgeArc ─────────────────────────────────

interface JudgeArcOpts {
  agentId: string;
  phone: string;
  /** Recent messages, in chronological order. Up to ~20 turns. */
  recentMessages: Array<{ role: string; content: string }>;
  /** Number of total contact turns now (used as `turn_count_at_eval`). */
  turnCount: number;
  /** Skip if last eval was within this many turns. Default 5. */
  reEvalEveryTurns?: number;
}

/**
 * Recompute the conversation arc verdict for a contact and persist into
 * contact_memory.arc. Idempotent — caller can call every turn; this
 * decides whether to actually run the judge based on `reEvalEveryTurns`.
 */
export async function judgeArc(opts: JudgeArcOpts): Promise<void> {
  try {
    const reEval = opts.reEvalEveryTurns ?? 5;

    // Read existing arc to decide if we need to re-evaluate.
    const [memory] = await db
      .select({ arc: contactMemory.arc })
      .from(contactMemory)
      .where(eq(contactMemory.agentId, opts.agentId))
      .limit(1);

    const existing = memory?.arc as ConversationArc | null | undefined;
    if (existing && existing.turn_count_at_eval) {
      if (opts.turnCount - existing.turn_count_at_eval < reEval) return;
    }

    // Need at least 2 turns to evaluate an arc (1 user + 1 assistant).
    if (opts.recentMessages.length < 2) return;

    const transcript = opts.recentMessages
      .slice(-20)
      .map((m) => `[${m.role}] ${String(m.content).slice(0, 400)}`)
      .join('\n');

    const judgeRes = await callJudgeLLM({
      systemPrompt: ARC_RUBRIC,
      userInput: '## Transcript\n' + transcript,
      maxTokens: 200,
    });
    if (!judgeRes) return;

    const cleaned = judgeRes.text
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/```\s*$/, '')
      .trim();

    let parsed: any;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      const m = cleaned.match(/\{[\s\S]*\}/);
      if (!m) return;
      try {
        parsed = JSON.parse(m[0]);
      } catch {
        return;
      }
    }

    const validStates = ['progressing', 'stuck', 'frustrated', 'closing', 'resolved'];
    if (!parsed || !validStates.includes(parsed.state)) return;

    const arc: ConversationArc = {
      state: parsed.state,
      signals: Array.isArray(parsed.signals)
        ? parsed.signals.map((s: unknown) => String(s).slice(0, 200)).slice(0, 3)
        : [],
      updated_at: new Date().toISOString(),
      turn_count_at_eval: opts.turnCount,
    };

    const { sql: drizzleSql } = await import('drizzle-orm');
    await db
      .update(contactMemory)
      .set({ arc: arc as unknown as Record<string, unknown>, updatedAt: new Date() })
      .where(drizzleSql`${contactMemory.agentId} = ${opts.agentId} AND ${contactMemory.phone} = ${opts.phone}`);
  } catch (err) {
    log.warn?.('judge_arc_fail', { error: String(err).slice(0, 300) });
  }
}

// ─── Convenience: build trace string from runAgent meta ────

export function buildTraceString(meta: {
  intent?: string | null;
  routed_agent?: string | null;
  owner_mode?: boolean;
  cache_hit?: boolean;
  cache_similarity?: number;
  tools_offered?: string[];
  tool_calls?: Array<{ name: string; ok: boolean; ms?: number; cost_usdc?: string; error?: string }>;
  iterations?: number;
  provider?: string;
  cost_usdc?: string;
  facts_used?: string[];
  buffered_msgs?: number;
  latency_ms?: number;
}): string {
  const parts: string[] = [];
  if (meta.intent) parts.push(`intent=${meta.intent}`);
  if (meta.routed_agent) parts.push(`agente_roteado=${meta.routed_agent}`);
  if (meta.owner_mode) parts.push('owner_mode=true');
  if (meta.cache_hit) parts.push(`cache_hit (similarity=${meta.cache_similarity?.toFixed(2)})`);
  if (meta.tools_offered?.length) parts.push(`tools_offered=[${meta.tools_offered.join(',')}]`);
  if (meta.tool_calls?.length) {
    parts.push(
      'tool_calls=' +
        meta.tool_calls
          .map((t) => `${t.name}(${t.ok ? '✓' : '✗'}${t.ms ? ` ${t.ms}ms` : ''})`)
          .join(', '),
    );
  }
  if (meta.iterations !== undefined) parts.push(`iter=${meta.iterations}`);
  if (meta.provider) parts.push(`provider=${meta.provider}`);
  if (meta.cost_usdc) parts.push(`cost=$${meta.cost_usdc}`);
  if (meta.facts_used?.length) parts.push(`facts_usados=[${meta.facts_used.join(',')}]`);
  if (meta.buffered_msgs && meta.buffered_msgs > 1) parts.push(`buffered=${meta.buffered_msgs}msgs`);
  if (meta.latency_ms) parts.push(`latency=${meta.latency_ms}ms`);
  return parts.join(' · ');
}
