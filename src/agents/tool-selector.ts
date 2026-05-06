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
  // Documents: PDF generation + appointment scheduling. Customers ask for
  // these in plain language ("me manda um comprovante", "marca pra terça").
  // Both also live in ALWAYS_ON, but keeping them in a category lets the
  // LLM classifier route here when the keyword pass misses.
  documents: ['generate_pdf', 'schedule_appointment'],
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
 * - search_catalog / send_listing_photo / send_catalog_pdf: the catalog
 *   triad. If the LLM can't see these tools, it falls back to writing
 *   "[CATÁLOGO COMPLETO]" / "[FOTO]" placeholders in plain text — exactly
 *   the bug we hit in production. Adding ~750 tokens here is cheap relative
 *   to that failure mode. Kept here in addition to TOOL_TO_AXON because
 *   smart selection runs BEFORE buildToolsArray and can otherwise drop
 *   them silently for turns that don't keyword-match.
 * - generate_pdf: same failure mode as the catalog tools — the system
 *   prompt teaches the LLM to call it for filtered subsets ("manda só
 *   as casas até 500 mil em PDF"), and customers naturally ask for
 *   comprovante / recibo / ficha / atestado / contrato all the time.
 *   Without always-on, the selector strips it for any turn whose
 *   keywords didn't match the (narrow) PDF regex below, leaving the
 *   LLM to either hallucinate "[PDF EM ANEXO]" or apologize that it
 *   can't generate documents — both broken UX.
 * - schedule_appointment: agendamento conversational — "marca pra
 *   terça às 14h". Same problem: not in any category, not keyword-
 *   matched outside narrow phrases, and the failure mode (silent
 *   no-op + agent saying "marquei aqui" with nothing persisted) is
 *   far worse than the ~250 tokens it costs.
 */
const ALWAYS_ON: string[] = [
  'search_web',
  'generate_pix',
  'search_catalog',
  'send_listing_photo',
  'send_catalog_pdf',
  'generate_pdf',
  'schedule_appointment',
];

/**
 * Tool-level keyword patterns. Each entry: tool name → regex.
 * When a regex matches, that EXACT tool is picked (not the whole category).
 *
 * The goal is to send the LLM the smallest possible tool set so the prompt
 * stays cheap. "qual banco código 260?" should pick lookup_bank ONLY, not
 * the 9 br_data tools.
 *
 * Patterns are intentionally specific — false positives waste tokens, but
 * false negatives just fall through to the LLM classifier (still safe).
 */
const TOOL_KEYWORDS: Record<string, RegExp> = {
  // Brazilian data — granular per tool
  lookup_cep:        /\bcep\b\s*\d{5}|c[oó]digo postal|qual o cep|busca cep|consulta cep/i,
  lookup_cnpj:       /\bcnpj\b|raz[aã]o social|s[oó]cios?\s+da\s+empresa|empresa\s+\d{2}\.\d{3}/i,
  lookup_bank:       /(c[oó]digo|n[uú]mero|cod\.)\s+(do\s+)?banco|banco\s+\d{3}|qual banco|banco\s+(itau|nubank|caixa|bradesco|santander|inter)|febraban/i,
  lookup_fipe:       /fipe|tabela fipe|valor (do|de) (carro|ve[ií]culo|moto|caminhao)|pre[çc]o (do|de) (carro|ve[ií]culo|moto)/i,
  ibge_city:         /\bibge\b|c[oó]digo de m[uú]nic[ií]pio|c[oó]digo ibge|m[uú]nic[ií]pio\s+\d{6,7}/i,
  brasilapi_holidays:/feriad/i,
  brasilapi_rates:   /selic|cdi|ipca|igp.?m|taxa b[aá]sica/i,
  brasilapi_ddd:     /\bddd\s+\d{2}|\bddd\b\s+(de|do)/i,
  bcb_indicator:     /(s[eé]rie|hist[oó]rico)\s+(da\s+)?(selic|ipca|cdi|d[oó]lar|ptax)|bacen|banco central|sgs/i,

  // Geo & weather
  current_weather:   /(?:clima|tempo|temperatura|chuva|chovendo|cal[oô]r|frio)\s+(?:em|de|na|no|hoje|agora)|qual\s+(?:o\s+)?clima/i,
  weather_forecast:  /previs[aã]o\s+(?:do\s+)?tempo|previs[aã]o\s+(?:para|amanh[aã]|semana)/i,
  geocode_address:   /coordenada|latitude|longitude|geocod|localiza[çc][aã]o\s+(?:de|do|da)\s+\w/i,
  route_distance:    /\bdist[aâ]ncia\b|trajeto|rota\s+(?:de|entre)|tempo\s+de\s+(?:carro|via|trajet)|\bkm\b\s+(?:de|at[ée])/i,
  lookup_country:    /capital de|popula[çc][aã]o de\s+\w|qual a moeda de|fronteiras de/i,
  lookup_ip:         /\bip\b\s+\d|geolocaliza|de onde [eé] (esse|este) ip/i,

  // Finance
  convert_currency:  /\b(?:converter|cota[çc][aã]o|c[aâ]mbio|d[oó]lar|euro|libra|peso\s+argentino|peso\s+chileno)\b|quanto\s+(?:[eé]|vale|est[aá])/i,
  crypto_price:      /\b(bitcoin|btc|ethereum|eth|solana|sol\b|usdc|usdt|cripto|cryptocurrency)\b/i,

  // Search
  search_web:        /\b(?:procur|pesquis|busca|googl|encontre|qual\s+o\s+melhor|me\s+ach)/i,
  scrape_url:        /\b(?:leia|ler|conte[uú]do|baix|scrape)\s+(?:o\s+)?(?:link|url|site|p[aá]gina)|https?:\/\//i,
  summarize_url:     /\bresum(?:e|a|ir)\s+(?:essa|esse|este|esta)?\s*(?:url|link|p[aá]gina|artigo|texto)/i,
  wikipedia_summary: /wikip[eé]dia|biografia de|quem (?:foi|[eé])/i,
  wikipedia_search:  /pesquisar?\s+(?:na\s+)?wiki/i,
  search_arxiv:      /\barxiv\b|paper\s+sobre|artigo cient[ií]fico/i,
  search_hn:         /hacker news|\bhn\b/i,
  github_user:       /(?:perfil|user|usu[aá]rio)\s+(?:do\s+)?github|@[\w\-]+\s+(?:do|no)\s+github/i,
  github_repo:       /reposit[oó]rio|repo\s+\w+\/\w+|\bgithub\.com\/[\w\-]+\/[\w\-]+/i,
  mercadolivre_search:/mercado livre|\bmlb\b|qual.+pre[çc]o.+ml\b|comprar\s+(?:no\s+)?ml/i,
  lookup_book:       /\bisbn\b|livro\s+\d{10,13}/i,
  npm_package:       /\bnpm\b|pacote\s+(?:do\s+)?node|\@[\w\-]+\/[\w\-]+/i,
  camara_proposicoes:/c[aâ]mara\s+(?:dos\s+)?deputados|projeto\s+de\s+lei|\bpec\b|proposi[çc][aã]o|tramita[çc][aã]o/i,
  world_holidays:    /feriado.+(?:no|em|dos?)\s+\w+|public holiday|holidays in|feriados\s+(?:em|de)\s+\w+/i,
  time_zone:         /que\s+horas?\s+s[aã]o\s+(?:em|na|no|agora)|hora\s+(?:em|de|na|no)\s+\w|fuso\s+hor[aá]rio/i,
  dict_define_en:    /define\s+\w+|defini[çc][aã]o\s+de\s+\w+\s+em\s+ingl[eê]s|english\s+definition/i,
  agify_name:        /idade\s+(?:de|do|da)\s+(?:nome|pessoa)|que\s+idade.+nome/i,
  // Sub-endpoints (granular alternatives)
  list_banks_br:     /lista\s+(?:de\s+)?todos?\s+(?:os\s+)?bancos|todos\s+os\s+bancos\s+brasileiros/i,
  fipe_brands:       /marcas\s+(?:da\s+)?fipe|lista\s+(?:de\s+)?marcas\s+(?:de\s+)?(?:carro|moto|veiculo)/i,
  github_search_repos:/(?:procur|busca|search).+(?:repos?|github)|melhores\s+repos|repos[ií]t[oó]rios?\s+sobre/i,
  ibge_states:       /lista\s+(?:de\s+)?estados\s+(?:do\s+)?brasil|todos\s+os\s+estados\s+(?:brasileiros)?|27 estados/i,
  ibge_cities_search:/lista\s+(?:de\s+)?(?:todas\s+)?(?:as\s+)?cidades|todos\s+os\s+munic[ií]pios|5570/i,
  book_search:       /(?:procur|busca)\s+(?:um\s+)?livro|livro\s+(?:do|de|sobre)\s+\w/i,
  reverse_geocode:   /coordenadas?\s+(?:para|->|virar)\s+endere[çc]o|que\s+endere[çc]o\s+[eé]\s+(?:essa|essas|esse)|reverse\s+geocod/i,
  mercadolivre_item: /detalhe\s+(?:do\s+)?(?:item|produto)\s+(?:do\s+)?ml|MLB\d{8,}/i,
  wikipedia_related: /(?:p[aá]ginas?|artigos?)\s+relacionad|(?:see\s+also|veja\s+tamb[eé]m).+wiki/i,
  // New no-key APIs
  reddit_search:     /\breddit\b|subreddit|\br\/[\w]+/i,
  stackoverflow_search:/stack\s*overflow|\bstackoverflow\b|\bSO\b\s+(?:question|pergunta)/i,
  wikidata_search:   /wikidata|\bq\d{4,}\b\s|knowledge\s+graph|grafo\s+de\s+conhecimento/i,
  wttr_weather:      /wttr|previs[aã]o\s+r[aá]pida|clima\s+(?:r[aá]pido|simples)/i,

  // Media + language
  generate_image:    /\b(?:gera|cri[ae]|fa[çc]a|desenh)\s+(?:uma?\s+)?(?:imagem|foto|figura|desenho|ilustra)|\bimagem\s+de\b/i,
  translate_text:    /\btraduz(?:ir|a)?\b|\btranslate\b|para\s+(?:o\s+)?ingl[eê]s|para\s+(?:o\s+)?espanhol/i,
  detect_language:   /qual\s+idioma|qual\s+(?:[eé]\s+)?(?:a\s+)?l[ií]ngua\s+(?:de|desse|deste|dessa|desta)/i,

  // Payment
  generate_pix:      /\b(?:gera|cri[ae])\s+(?:um\s+)?pix|cobr(?:ar|an[çc]a)|como\s+(?:eu\s+)?pago|forma\s+de\s+pagamento|quero\s+pagar/i,

  // Documents — PDF generation
  // Matches: "comprovante", "recibo", "ficha", "atestado", "declaração",
  // "contrato", "receita", "orientação", "agendamento" (as a doc, not the
  // appointment action), "em pdf", "manda em pdf", "documento". Also
  // catches "PDF" standalone but only when paired with a verb to avoid
  // false positives on the catalog triad which has its own keyword.
  generate_pdf:      /\b(?:comprovante|recibo|ficha(?:\s+do\s+(?:cliente|paciente|cadastro))?|atestado|declara[çc][aã]o|contrato|or[çc]amento|receita\s+(?:m[eé]dica|virtual|prescri[çc][aã]o)|orienta[çc][aã]o\s+(?:pr[eé]|p[oó]s)|laudo|termo\s+(?:de|para))\b|(?:em|no|em\s+formato\s+de)\s+pdf|\bdocumento\s+(?:em|para|com)|\b(?:gera|fa[çc]a|crie?|preciso\s+(?:de|do)|me\s+manda|me\s+passa)\s+(?:um\s+|uma\s+)?(?:comprovante|recibo|ficha|atestado|contrato|pdf|documento)/i,

  // Documents — appointment scheduling
  // Distinct from "fazer agendamento" + send PDF — this fires when the
  // customer is committing to a slot. "marca pra terça", "agenda às 14h",
  // "consulta dia 5", "horário disponível dia X". Tight on purpose to
  // not fire on every "que horas vocês abrem" question.
  schedule_appointment: /\b(?:marca(?:r|\s+pra)|agendar?|reservar?|encaixar?)\s+(?:um[a]?\s+)?(?:hor[aá]rio|consulta|atendimento|visita|sess[aã]o|reuni[aã]o|encaixe|pra\s+(?:terça|quarta|quinta|sexta|s[aá]bado|domingo|segunda|amanh[aã]|hoje|próxim))|\b(?:dia|terça|quarta|quinta|sexta|s[aá]bado|segunda)\s+(?:que\s+vem|\d{1,2})\s+(?:[aà]s\s+)?\d{1,2}h?|tem\s+(?:hor[aá]rio|vaga)\s+(?:dispon[ií]vel|livre)/i,
};

/**
 * Keyword-based quick heuristic. Returns the SPECIFIC tools (not categories)
 * that obviously apply to the message, or [] if nothing matches.
 *
 * Granular by design — picking 1-2 tools beats picking 9 because of token
 * overhead. Brazilian Portuguese keywords are intentional (target market).
 */
/** Hard cap on how many tools the keyword pass injects into a turn. Each
 * tool costs ~200-300 prompt tokens, so 8 matches blow ~2k tokens which
 * would erase the savings the knowledge cache provides. 3 covers the
 * realistic single-turn intent ("CEP do banco do Brasil em São Paulo"
 * needs at most lookup_cep + lookup_cnpj + current_weather). */
const QUICK_PICK_CAP = 3;

function quickPickTools(text: string): string[] {
  const t = text.toLowerCase();
  // Score each tool by how many distinct keyword tokens it matched —
  // longer/more-specific matches win over a single generic word.
  const scored: Array<{ tool: string; score: number }> = [];
  for (const [tool, pattern] of Object.entries(TOOL_KEYWORDS)) {
    const matches = t.match(new RegExp(pattern.source, pattern.flags + (pattern.flags.includes('g') ? '' : 'g')));
    if (matches && matches.length > 0) {
      // Score = unique-match count, weighted by total length so longer
      // domain terms (e.g. "comprovante de pagamento") outrank a stray
      // filler word.
      const uniq = new Set(matches.map((m) => m.toLowerCase())).size;
      const lenWeight = matches.reduce((acc, m) => acc + m.length, 0);
      scored.push({ tool, score: uniq * 100 + lenWeight });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, QUICK_PICK_CAP).map((x) => x.tool);
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

  // Phase 1: keyword heuristic — picks SPECIFIC tools, not categories.
  // For the 80% case (one obvious intent like "qual banco código 260"),
  // this nails 1-2 tools without spending an LLM call.
  const directTools = quickPickTools(messageText);
  let usedLLM = false;
  let categories: string[] = [];

  // Build the wanted-tools set
  const wanted = new Set<string>(directTools);

  // Phase 2: LLM fallback ONLY when keywords didn't pick anything. The
  // classifier still returns categories (cheaper prompt), and we expand
  // those into their tools — wider than ideal but it's a fallback.
  if (directTools.length === 0 && !opts.skipLLM) {
    categories = await classifyWithLLM(messageText);
    usedLLM = true;
    for (const cat of categories) {
      for (const t of TOOL_CATEGORIES[cat] || []) wanted.add(t);
    }
  }

  // Always-on safety net (search_web fallback + generate_pix flow)
  for (const t of ALWAYS_ON) wanted.add(t);

  let tools = availableTools.filter((t) => wanted.has(t));

  // Safety net: if narrowing left us with literally nothing the agent
  // can reach for, return the full set rather than tying its hands.
  // This happens if (e.g.) the agent has only `lookup_cnpj` enabled but
  // the classifier picked geo — the agent would have nothing to use.
  if (tools.length === 0) {
    tools = availableTools.slice();
  }

  return { tools, categories, usedLLM };
}
