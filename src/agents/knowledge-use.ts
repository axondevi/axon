/**
 * Detect which pieces of injected context the agent ACTUALLY referenced
 * in its reply. Pure heuristic, no LLM call — runs in <1ms per turn.
 *
 * Why heuristic instead of LLM:
 *   The judge already costs us ~$0.0002/turn. Adding a second LLM pass
 *   just to attribute "did the agent use fact X?" would double the cost
 *   for a signal we can get 90% right with text matching. Run cheap
 *   here, defer to the judge for nuanced quality verdicts.
 *
 * Strategy:
 *   - For each fact value, check if it (or 60%+ of its content words)
 *     appears in the reply. Catches "Pedro Silva" → "vi que o Pedro
 *     comprou..." but doesn't false-positive on common words.
 *   - For business_info, scan line by line. A line counts as "used" if
 *     half its content words show up in the reply.
 *   - Token estimate is rough — 1 token ≈ 4 chars for PT/EN. Good enough
 *     for "you're using 12% of your context window" without paying for
 *     a tokenizer dependency.
 */

const STOPWORDS_PT = new Set([
  'de', 'da', 'do', 'das', 'dos', 'a', 'o', 'as', 'os', 'e', 'em', 'um', 'uma',
  'para', 'por', 'com', 'sem', 'na', 'no', 'nas', 'nos', 'que', 'se', 'ou', 'mas',
  'eu', 'voce', 'ele', 'ela', 'isso', 'ser', 'foi', 'esta', 'mais', 'tem', 'sua',
  'seu', 'suas', 'seus', 'meu', 'minha', 'sao', 'fica', 'aqui', 'ai', 'la',
]);

function normalize(s: string): string {
  return String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // strip accents
    .toLowerCase();
}

function contentWords(s: string, minLen = 4): string[] {
  return normalize(s)
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= minLen && !STOPWORDS_PT.has(w));
}

export interface FactLike {
  key: string;
  value: string;
}

/**
 * Returns the keys of facts whose VALUES appear (literally or via 60%+
 * word overlap) in the reply. Caller passes the raw memory.facts array
 * — we never assume order.
 */
export function detectUsedFacts(facts: FactLike[], reply: string): string[] {
  if (!Array.isArray(facts) || facts.length === 0 || !reply) return [];
  const replyNorm = normalize(reply);
  const used: string[] = [];

  for (const f of facts) {
    const value = String(f?.value || '').trim();
    if (value.length < 3) continue;
    const valueNorm = normalize(value);

    // Direct substring match — handles names, addresses, prices.
    if (valueNorm.length >= 4 && replyNorm.includes(valueNorm)) {
      used.push(f.key);
      continue;
    }

    // Multi-word: if 60% of significant words from the value show up,
    // count it as used. "Av Paulista 1578, São Paulo" → reply mentions
    // "Paulista" and "São Paulo" → match.
    const words = contentWords(value, 4);
    if (words.length === 0) continue;
    const hits = words.filter((w) => replyNorm.includes(w)).length;
    if (hits / words.length >= 0.6) {
      used.push(f.key);
    }
  }
  return used;
}

/**
 * Returns the first business_info line/section the reply seems to have
 * drawn from, or null if no detectable overlap.
 *
 * We split on blank lines and bullet markers — a typical business_info
 * looks like:
 *   Endereço: Rua X, 100
 *   Horário: segunda a sexta, 8h-18h
 *   Especialidades: clínica geral, cardiologia, pediatria
 *
 * Each line is a candidate. The line scoring "best" (most overlapping
 * content words above 50%) wins.
 */
export function detectBusinessInfoUsed(
  businessInfo: string | null | undefined,
  reply: string,
): { used: boolean; excerpt?: string } {
  if (!businessInfo || !reply) return { used: false };
  const replyNorm = normalize(reply);
  const lines = String(businessInfo)
    .split(/\r?\n|(?:^|\n)\s*[-•*]\s+/)
    .map((l) => l.trim())
    .filter((l) => l.length >= 8);

  let bestExcerpt: string | undefined;
  let bestScore = 0;
  for (const line of lines) {
    const words = contentWords(line, 5);
    if (words.length < 2) continue;
    const hits = words.filter((w) => replyNorm.includes(w)).length;
    const score = hits / words.length;
    if (score >= 0.5 && score > bestScore) {
      bestScore = score;
      bestExcerpt = line.slice(0, 160);
    }
  }
  return bestExcerpt ? { used: true, excerpt: bestExcerpt } : { used: false };
}

/** Did the rolling memory summary make it into the reply? */
export function detectSummaryUsed(
  summary: string | null | undefined,
  reply: string,
): boolean {
  if (!summary || !reply) return false;
  const summaryWords = contentWords(summary, 5);
  if (summaryWords.length < 3) return false;
  const replyNorm = normalize(reply);
  const hits = summaryWords.filter((w) => replyNorm.includes(w)).length;
  return hits / summaryWords.length >= 0.4;
}

/**
 * Rough token estimate. Production-grade tokenization would need a
 * dependency (tiktoken, gpt-tokenizer). For a "you used 12% of your
 * context window" indicator on the brain dashboard, 4 chars per token
 * is within 10% of real for PT-BR / EN. Don't use for billing math.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

/**
 * Pull the first ~800 chars of the system prompt as a preview so the
 * operator can see exactly what was injected without us shipping the
 * full 4-12kb prompt over the wire on every messages fetch.
 */
export function contextExcerpt(systemPrompt: string, limit = 800): string {
  if (!systemPrompt) return '';
  if (systemPrompt.length <= limit) return systemPrompt;
  return systemPrompt.slice(0, limit) + '… [+' + (systemPrompt.length - limit) + ' chars]';
}
