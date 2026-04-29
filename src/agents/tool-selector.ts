/**
 * Smart tool selection — pick only the tools relevant to the current turn,
 * instead of dumping the full 20+ tool catalog into every LLM call.
 *
 * Why this exists:
 *   - Each tool's JSON schema costs ~250 tokens of input. With 20 tools that's
 *     5,000 input tokens *per turn*, before the user's message even loads.
 *   - On the Groq free tier (100k tokens/day), that means ~20 turns per day
 *     before rate-limited — unacceptable for a production agent serving a
 *     business.
 *   - The user explicitly said: "agente pode responder em 5-7s, o importante
 *     é entender". So spending 300-500ms on a quick pre-classifier in
 *     exchange for 70% fewer tokens is a great trade.
 *
 * Approach (in order):
 *   1. KEYWORD HEURISTIC (free, ~1ms): if the message clearly maps to a
 *      single category (e.g. "CEP 01310" → br_data, "clima em SP" → geo),
 *      use just that category's tools. No LLM call needed.
 *   2. LLM CLASSIFIER (one Groq 8b-instant call, ~300ms, ~150 tokens out):
 *      ask the model to pick from a small fixed set of category names.
 *      Used when the keyword heuristic is ambiguous or empty.
 *   3. ALWAYS-ON tools: a small set the LLM can always reach for, even when
 *      not classified into the picked categories. Keeps the agent from
 *      getting stuck if the classifier missed something obvious (search_web
 *      fallback) and from breaking flows that depend on a specific tool
 *      (generate_pix during a paying conversation).
 *
 * This module is pure (no DB), so it's cheap to call and easy to test.
 */
import { upstreamKeyFor } from '~/config';

/**
 * Category → tool names. Mirrors the dashboard's TOOL_CATALOG sections so
 * users see roughly the same grouping wherever they look.
 */
export const TOOL_CATEGORIES: Record<string, string[]> = {
  br_data: [
    'lookup_cnpj',
    'lookup_cep',
    'lookup_bank',
    'lookup_fipe',
    'ibge_city',
    'brasilapi_holidays',
    'brasilapi_rates',
    'brasilapi_ddd',
    'bcb_indicator',
  ],
  geo: [
    'current_weather',
    'weather_forecast',
    'geocode_address',
    'route_distance',
    'lookup_country',
    'lookup_ip',
  ],
  finance: ['convert_currency', 'crypto_price'],
  search: [
    'search_web',
    'exa_search',
    'scrape_url',
    'wikipedia_summary',
    'wikipedia_search',
    'search_hn',
    'search_arxiv',
    'github_user',
  ],
  media: ['generate_image', 'embed_text'],
  payment: ['generate_pix'],
};

/**
 * Tools that ALWAYS go into the prompt even when not in a picked category.
 * Keep this list TINY — every entry adds ~250 tokens to every turn.
 *
 * - search_web: ultimate fallback when the agent can't find a precise tool
 *   for what the user asked. Better to leave the door open than have the
 *   model hallucinate.
 * - generate_pix: payment is a flow that can be triggered mid-conversation
 *   ("pode mandar o Pix?"). Without keeping this always-on, the agent
 *   would need to reclassify after every customer turn.
 */
const ALWAYS_ON: string[] = ['search_web', 'generate_pix'];

/**
 * Keyword-based quick heuristic. Returns the categories that obviously
 * apply to the message, or [] if nothing matches.
 *
 * Brazilian keywords are intentional (target market is BR).
 */
function quickPickCategories(text: string): string[] {
  const t = text.toLowerCase();
  const picked = new Set<string>();

  // BR data: CEP/CNPJ/banco/empresa/feriado
  if (
    /\bcep\b|cnpj|empresa|raz[aã]o social|s[oó]cios?|banco|c[oó]digo do banco|nubank|ita[uú]|bradesco|santander|caixa|brasilapi|fipe|carro|moto|placa|ve[ií]culo|feriado|s[eê]lic|ipca|cdi|igpm|m[uú]nic[ií]pio|ibge|ddd \d/.test(t)
  ) {
    picked.add('br_data');
  }

  // Geo / location / logistics
  if (
    /\bclima\b|tempo|chuva|temperatura|previs[aã]o|grau|coordenada|latitude|longitude|endere[çc]o|rota|distancia|distância|trajeto|frete|entrega|km\b|quilometro|cidade|capital de|pa[ií]s\b|estado de\b/.test(t)
  ) {
    picked.add('geo');
  }

  // Finance
  if (
    /\bd[oó]lar|euro|libra|real\b|cota[çc][aã]o|conversão|converter|c[aâ]mbio|currency|moeda|bitcoin|crypto|ethereum|solana|eth\b|btc\b|usdc|usdt/.test(t)
  ) {
    picked.add('finance');
  }

  // Search / knowledge
  if (
    /\bpesquis|procura|busca|google|wikipedia|wiki|arxiv|paper|cient[íi]fic|hacker news|github|repos?[íi]t[oó]rio|c[oó]digo aberto|website|http|url|link/.test(t)
  ) {
    picked.add('search');
  }

  // Media generation
  if (
    /\b(gere|gera|fa[çc]a|cri[ae])\s+(uma?\s+)?(imagem|foto|figura|desenho|ilustra)/.test(t)
  ) {
    picked.add('media');
  }

  // Payment intent
  if (
    /\b(pagar|pagamento|pix|gerar pix|cobran[çc]a|pagar o|pago|cobrar)\b|como (eu )?pago/.test(t)
  ) {
    picked.add('payment');
  }

  return Array.from(picked);
}

/**
 * LLM fallback classifier — single Groq 8b call. Returns the picked
 * categories. Designed to be CHEAP: max 30 output tokens, system prompt
 * <200 tokens. Total roundtrip: ~300ms, ~250 input + 30 output tokens.
 *
 * Returns [] on any failure — caller treats that as "no signal", which
 * combined with ALWAYS_ON gives the model search_web as a fallback.
 */
async function classifyWithLLM(text: string): Promise<string[]> {
  const groqKey = upstreamKeyFor('groq');
  if (!groqKey) return [];

  const SYS = `Você categoriza mensagens de WhatsApp em categorias de FERRAMENTAS que o agente pode precisar.

Categorias disponíveis (escolha de 0 a 3, separadas por vírgula):
- br_data: dados brasileiros (CNPJ, CEP, banco, FIPE, IBGE, feriados, Selic/IPCA)
- geo: localização (clima, coordenadas, distância, rota, país, IP)
- finance: câmbio, conversão de moeda, cripto
- search: busca na web, Wikipedia, GitHub, papers, scraping
- media: gerar imagem
- payment: gerar Pix, cobrança
- none: conversa simples, sem necessidade de ferramenta

Responda APENAS com os nomes separados por vírgula, em minúsculas, sem nada mais. Ex:
- "qual a Selic?" → br_data
- "boa tarde" → none
- "preço do iPhone e foto dele" → search,media`;

  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + groqKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'llama-3.1-8b-instant',
        messages: [
          { role: 'system', content: SYS },
          { role: 'user', content: text.slice(0, 800) },
        ],
        max_tokens: 30,
        temperature: 0,
      }),
    });
    if (!res.ok) return [];
    const json: any = await res.json().catch(() => null);
    const raw = String(json?.choices?.[0]?.message?.content || '').toLowerCase().trim();
    const valid = new Set(Object.keys(TOOL_CATEGORIES));
    const cats = raw
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter((s) => valid.has(s));
    return cats;
  } catch {
    return [];
  }
}

/**
 * Pick the tools to expose for this turn. Hybrid keyword + LLM-fallback.
 *
 * `availableTools` is the agent's `allowed_tools` — we never widen beyond
 * what the owner enabled. We only NARROW from there.
 *
 * `lastUserMessage` is the most recent user turn. For multi-bubble bursts
 * (where buffer.ts merged 3 messages), this is the merged text — that's
 * what gives the classifier full context.
 *
 * Returns a subset of `availableTools` plus any always-on tools that
 * happen to be available. If something goes wrong (LLM classifier fails,
 * weird input), falls back to the full availableTools — degrading
 * gracefully to "no narrowing" rather than risking the agent missing a
 * tool it needed.
 */
export async function pickToolsForTurn(opts: {
  availableTools: string[];
  lastUserMessage: string;
  /** Skip the LLM classifier entirely (e.g. for tests, or when callers
   *  don't want to spend the extra ~300ms). */
  skipLLM?: boolean;
}): Promise<{ tools: string[]; categories: string[]; usedLLM: boolean }> {
  const { availableTools, lastUserMessage } = opts;
  const messageText = String(lastUserMessage || '').trim();

  // Empty or trivial messages → just return always-on tools (filtered to
  // what the agent has). Avoids spending an LLM call on "oi".
  if (messageText.length < 4) {
    const onlyAlwaysOn = ALWAYS_ON.filter((t) => availableTools.includes(t));
    return { tools: onlyAlwaysOn, categories: [], usedLLM: false };
  }

  // Phase 1: keyword heuristic (free)
  let categories = quickPickCategories(messageText);
  let usedLLM = false;

  // Phase 2: LLM fallback when keywords didn't pick anything definitive
  if (categories.length === 0 && !opts.skipLLM) {
    categories = await classifyWithLLM(messageText);
    usedLLM = true;
  }

  // Build the tool set: union of (a) tools from picked categories, (b)
  // always-on tools, intersected with what the agent has enabled.
  const wanted = new Set<string>();
  for (const cat of categories) {
    for (const t of TOOL_CATEGORIES[cat] || []) wanted.add(t);
  }
  for (const t of ALWAYS_ON) wanted.add(t);

  let tools = availableTools.filter((t) => wanted.has(t));

  // Safety net: if narrowing left us with literally nothing the agent
  // can reach for, return the full set rather than tying its hands.
  // This happens if (e.g.) the agent has only `lookup_cnpj` enabled but
  // the classifier picked "geo" — the agent would have nothing to use.
  if (tools.length === 0) {
    tools = availableTools.slice();
  }

  return { tools, categories, usedLLM };
}
