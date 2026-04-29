/**
 * Server-side agent runtime.
 *
 * Customers (mobile apps, backend services, n8n flows, anything that can
 * speak HTTP) hit POST /v1/run/:slug/chat with a single message or a
 * messages array, and the server runs the FULL agent loop here:
 *   1. Build system prompt + Groq tools array from agent.allowed_tools
 *   2. Call Groq with stream=false (we want a clean JSON response)
 *   3. If the model returned tool_calls, execute each via handleCall()
 *      (which respects cache, fallbacks, metering, request logging)
 *   4. Append tool results, loop until model produces a content-only
 *      message OR we hit max iterations
 *   5. Return the final assistant text + a summary of tools executed
 *
 * Tool definitions live here (mirroring landing/dashboard.html TOOL_DEFS
 * but only network-backed tools — local tools like calculate / run_js
 * make no sense in a server-only context, the model can do basic math).
 */
import type { Context } from 'hono';
import { handleCall } from '~/wrapper/engine';
import { TOOL_TO_AXON } from '~/agents/templates';
import { upstreamKeyFor } from '~/config';
import { checkCache, storeInCache } from '~/agents/knowledge-cache';
import { pickToolsForTurn } from '~/agents/tool-selector';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | null;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

interface ToolDef {
  description: string;
  parameters: Record<string, unknown>;
  /** Transform LLM args → upstream params/body. Defaults to identity. */
  buildRequest?: (args: any) => { params?: Record<string, unknown>; body?: unknown };
}

export const SERVER_TOOLS: Record<string, ToolDef> = {
  lookup_cnpj: {
    description: 'Look up a Brazilian company by CNPJ.',
    parameters: { type: 'object', properties: { cnpj: { type: 'string' } }, required: ['cnpj'] },
    buildRequest: (a) => ({ params: { cnpj: String(a.cnpj).replace(/\D/g, '') } }),
  },
  lookup_cep: {
    description: 'Look up a Brazilian postal code.',
    parameters: { type: 'object', properties: { cep: { type: 'string' } }, required: ['cep'] },
    buildRequest: (a) => ({ params: { cep: String(a.cep).replace(/\D/g, '') } }),
  },
  current_weather: {
    description: 'Current weather for a city.',
    parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
    buildRequest: (a) => ({ params: { q: a.q } }),
  },
  weather_forecast: {
    description: 'Multi-day weather forecast by lat/lon.',
    parameters: {
      type: 'object',
      properties: { latitude: { type: 'number' }, longitude: { type: 'number' }, forecast_days: { type: 'integer' } },
      required: ['latitude', 'longitude'],
    },
    buildRequest: (a) => ({
      params: {
        latitude: a.latitude,
        longitude: a.longitude,
        current: 'temperature_2m,weather_code,wind_speed_10m',
        daily: 'temperature_2m_max,temperature_2m_min,precipitation_sum',
        forecast_days: a.forecast_days || 3,
        timezone: 'auto',
      },
    }),
  },
  lookup_ip: {
    description: 'IP geolocation + ISP lookup.',
    parameters: { type: 'object', properties: { ip: { type: 'string' } }, required: ['ip'] },
    buildRequest: (a) => ({ params: { ip: a.ip } }),
  },
  lookup_country: {
    description: 'World country data — population, capital, currencies, languages.',
    parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    buildRequest: (a) => ({ params: { name: a.name, fields: 'name,capital,population,currencies,languages,region,flag' } }),
  },
  brasilapi_holidays: {
    description: 'Brazilian national holidays for a year.',
    parameters: { type: 'object', properties: { year: { type: 'integer' } }, required: ['year'] },
    buildRequest: (a) => ({ params: { ano: String(a.year) } }),
  },
  brasilapi_rates: {
    description: 'Current Selic / CDI / IPCA.',
    parameters: { type: 'object', properties: {} },
    buildRequest: () => ({ params: {} }),
  },
  brasilapi_ddd: {
    description: 'Brazilian phone area code → state + cities.',
    parameters: { type: 'object', properties: { ddd: { type: 'string' } }, required: ['ddd'] },
    buildRequest: (a) => ({ params: { ddd: String(a.ddd).replace(/\D/g, '') } }),
  },
  convert_currency: {
    description: 'FX conversion via ECB rates (Frankfurter).',
    parameters: {
      type: 'object',
      properties: { amount: { type: 'number' }, from: { type: 'string' }, to: { type: 'string' } },
      required: ['amount', 'from', 'to'],
    },
    buildRequest: (a) => ({
      params: { amount: a.amount, base: String(a.from || '').toUpperCase(), symbols: String(a.to || '').toUpperCase() },
    }),
  },
  crypto_price: {
    description: 'Current crypto prices via CoinGecko.',
    parameters: {
      type: 'object',
      properties: { ids: { type: 'string' }, vs_currencies: { type: 'string' } },
      required: ['ids'],
    },
    buildRequest: (a) => ({
      params: {
        ids: String(a.ids || '').toLowerCase(),
        vs_currencies: String(a.vs_currencies || 'usd,brl').toLowerCase(),
        include_24hr_change: 'true',
      },
    }),
  },
  search_web: {
    description: 'Tavily web search — broad queries, news.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string' }, max_results: { type: 'integer' } },
      required: ['query'],
    },
    buildRequest: (a) => ({ body: { query: a.query, max_results: a.max_results || 3, search_depth: 'basic' } }),
  },
  exa_search: {
    description: 'Exa neural search — semantic + technical.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string' }, num_results: { type: 'integer' } },
      required: ['query'],
    },
    buildRequest: (a) => ({ body: { query: a.query, numResults: a.num_results || 5, type: 'auto' } }),
  },
  scrape_url: {
    description: 'Fetch any URL as clean markdown (Firecrawl).',
    parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
    buildRequest: (a) => ({ body: { url: a.url, formats: ['markdown'], onlyMainContent: true } }),
  },
  search_hn: {
    description: 'Search Hacker News.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string' }, hitsPerPage: { type: 'integer' } },
      required: ['query'],
    },
    buildRequest: (a) => ({ params: { query: a.query, tags: 'story', hitsPerPage: a.hitsPerPage || 5 } }),
  },
  wikipedia_summary: {
    description: 'Wikipedia article summary (lead paragraph).',
    parameters: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] },
    buildRequest: (a) => ({ params: { title: String(a.title || '').replace(/ /g, '_') } }),
  },
  wikipedia_search: {
    description: 'Search Wikipedia.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string' }, limit: { type: 'integer' } },
      required: ['query'],
    },
    buildRequest: (a) => ({
      params: { action: 'query', list: 'search', srsearch: a.query, srlimit: a.limit || 5, format: 'json', origin: '*' },
    }),
  },
  embed_text: {
    description: 'Generate a 512-dim embedding (Voyage AI).',
    parameters: { type: 'object', properties: { input: { type: 'string' } }, required: ['input'] },
    buildRequest: (a) => ({ body: { input: a.input, model: 'voyage-3-lite' } }),
  },
  generate_image: {
    description:
      'Generate an image from a text prompt (Stable Diffusion XL). The prompt should be in English for best quality — translate user requests to English before calling. Returns a confirmation; the image is delivered to the user separately via the channel (e.g. WhatsApp).',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Detailed English description of the image.' },
        width: { type: 'integer', enum: [1024, 1152, 1216, 1344], description: 'Default 1024.' },
        height: { type: 'integer', enum: [1024, 896, 832, 768], description: 'Default 1024.' },
      },
      required: ['prompt'],
    },
    buildRequest: (a) => ({
      body: {
        text_prompts: [{ text: String(a.prompt || '').slice(0, 2000), weight: 1 }],
        cfg_scale: 7,
        steps: 30,
        width: a.width || 1024,
        height: a.height || 1024,
        samples: 1,
      },
    }),
  },
  generate_pix: {
    description:
      'Generate a Brazilian Pix payment for the customer to pay in-chat. Returns the QR code and copy-paste string. The QR is delivered automatically via WhatsApp; you only need to confirm to the customer. Use ONLY when the customer explicitly wants to pay (asked "como pago?", "quero comprar", etc).',
    parameters: {
      type: 'object',
      properties: {
        amount_brl: { type: 'number', description: 'Amount in Brazilian Reais (e.g. 49.90).' },
        description: { type: 'string', description: 'Short description shown on the customer\'s banking app (e.g. "Hambúrguer + batata + refri").' },
      },
      required: ['amount_brl', 'description'],
    },
    // No buildRequest — generate_pix is intercepted server-side and routed to
    // our internal MercadoPago wrapper, NOT to handleCall.
  },

  // ─── Brazilian financial data ─────────────────────────────────
  lookup_bank: {
    description: 'Look up a Brazilian bank by 3-digit FEBRABAN code (e.g. 001=Banco do Brasil, 341=Itaú, 260=Nubank).',
    parameters: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] },
    buildRequest: (a) => ({ params: { code: String(a.code).replace(/\D/g, '').padStart(3, '0') } }),
  },
  lookup_fipe: {
    description: 'Get FIPE-table price for a Brazilian vehicle (cars, motorcycles, trucks). Pass the FIPE code obtained from the brand/model lookup. Useful for used-vehicle pricing, insurance quotes, dealership negotiation.',
    parameters: { type: 'object', properties: { codigoFipe: { type: 'string', description: 'FIPE code, format like "001004-9".' } }, required: ['codigoFipe'] },
    buildRequest: (a) => ({ params: { codigoFipe: String(a.codigoFipe).trim() } }),
  },

  // ─── Geo & maps (free, no key) ────────────────────────────────
  geocode_address: {
    description: 'Convert a free-form address (e.g. "Av Paulista 1578, São Paulo") into coordinates and a normalized address. Useful for delivery range, store proximity, mapping pins.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Free-form address — street, number, city, state.' },
        limit: { type: 'integer', description: 'Max results (default 1).' },
      },
      required: ['query'],
    },
    buildRequest: (a) => ({
      params: { q: a.query, format: 'json', limit: a.limit || 1, addressdetails: 1 },
    }),
  },
  route_distance: {
    description: 'Compute driving distance and duration between two addresses or coordinate pairs. Pass origin and destination as either coords ("lon,lat") or full addresses. Useful for delivery fee, ETA, trip planning. Returns distance in km and duration in minutes.',
    parameters: {
      type: 'object',
      properties: {
        from_lon: { type: 'number', description: 'Origin longitude.' },
        from_lat: { type: 'number', description: 'Origin latitude.' },
        to_lon: { type: 'number', description: 'Destination longitude.' },
        to_lat: { type: 'number', description: 'Destination latitude.' },
      },
      required: ['from_lon', 'from_lat', 'to_lon', 'to_lat'],
    },
    buildRequest: (a) => ({
      // OSRM expects coordinates baked into the path (`/route/v1/driving/lon1,lat1;lon2,lat2`)
      // — substitutePath() resolves :coordinates from this single param.
      params: {
        coordinates: `${a.from_lon},${a.from_lat};${a.to_lon},${a.to_lat}`,
        overview: 'false',
      },
    }),
  },

  // ─── Macroeconomic indicators ────────────────────────────────
  bcb_indicator: {
    description: 'Fetch the most recent N data points of a Banco Central time series. Common SGS codes: Selic=11, IPCA=433, USD/BRL PTAX (venda)=1, IGP-M=189, CDI=12. Use for financial advice, contract adjustments, debt calc.',
    parameters: {
      type: 'object',
      properties: {
        codigo: { type: 'string', description: 'SGS code (e.g. "11" for Selic).' },
        n: { type: 'integer', description: 'Number of recent points to fetch (default 12).' },
      },
      required: ['codigo'],
    },
    buildRequest: (a) => ({
      params: {
        codigo: String(a.codigo).replace(/\D/g, ''),
        n: a.n || 12,
        formato: 'json',
      },
    }),
  },

  // ─── IBGE (Brazilian municipalities & states) ────────────────
  ibge_city: {
    description: 'Get IBGE data for a Brazilian municipality by its 7-digit code (e.g. 3550308 = São Paulo). Returns name, microregion, mesoregion, state. Use for regional analysis, demographic context, address validation.',
    parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    buildRequest: (a) => ({ params: { id: String(a.id).replace(/\D/g, '') } }),
  },

  // ─── GitHub ──────────────────────────────────────────────────
  github_user: {
    description: "Public GitHub profile by login. Returns name, bio, followers, public repos, location. Useful for developer outreach, recruiter agents, OSS-aware support.",
    parameters: { type: 'object', properties: { login: { type: 'string' } }, required: ['login'] },
    buildRequest: (a) => ({ params: { login: String(a.login).trim() } }),
  },

  // ─── Marketplace (BR) ────────────────────────────────────────
  mercadolivre_search: {
    description: 'Search products on Mercado Livre Brasil. Useful for price comparisons, market research, finding alternatives.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query (product name).' },
        limit: { type: 'integer', description: 'Max results (default 10, max 50).' },
      },
      required: ['query'],
    },
    buildRequest: (a) => ({
      params: { q: a.query, limit: Math.min(a.limit || 10, 50) },
    }),
  },

  // ─── Books ───────────────────────────────────────────────────
  lookup_book: {
    description: 'Look up a book by ISBN (10 or 13 digits). Returns title, authors, publisher, publish date, subjects. Useful for libraries, bookstores, edu agents.',
    parameters: { type: 'object', properties: { isbn: { type: 'string' } }, required: ['isbn'] },
    buildRequest: (a) => ({ params: { isbn: String(a.isbn).replace(/\D/g, '') } }),
  },

  // ─── npm packages ────────────────────────────────────────────
  npm_package: {
    description: 'npm registry metadata for a package. Returns versions, latest, repo, homepage, description, maintainers. Useful for dev agents, package recommendations.',
    parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    buildRequest: (a) => ({ params: { name: String(a.name).trim() } }),
  },

  // ─── Câmara dos Deputados ────────────────────────────────────
  camara_proposicoes: {
    description: 'Search Brazilian Câmara dos Deputados propositions (PL, PEC, MP, projetos de lei). Pass keyword(s) or specific siglaTipo+numero+ano. Useful for legal/political agents tracking legislation.',
    parameters: {
      type: 'object',
      properties: {
        keywords: { type: 'string', description: 'Keywords to search in propositions (e.g. "imposto renda").' },
        siglaTipo: { type: 'string', description: 'Optional: PL, PEC, MP, etc.' },
        numero: { type: 'integer' },
        ano: { type: 'integer' },
        itens: { type: 'integer', description: 'Max results (default 10).' },
      },
    },
    buildRequest: (a) => {
      const params: Record<string, unknown> = { itens: Math.min(a.itens || 10, 50), ordem: 'DESC', ordenarPor: 'id' };
      if (a.keywords) params.keywords = a.keywords;
      if (a.siglaTipo) params.siglaTipo = a.siglaTipo;
      if (a.numero) params.numero = a.numero;
      if (a.ano) params.ano = a.ano;
      return { params };
    },
  },

  // ─── World holidays ──────────────────────────────────────────
  world_holidays: {
    description: 'Public holidays for a country and year. Use ISO country codes: BR (Brasil), US, AR, MX, PT, etc. Returns list with date, local name, English name.',
    parameters: {
      type: 'object',
      properties: {
        year: { type: 'integer' },
        countryCode: { type: 'string', description: 'ISO 3166-1 alpha-2 (e.g. BR, US).' },
      },
      required: ['year', 'countryCode'],
    },
    buildRequest: (a) => ({ params: { year: a.year, countryCode: String(a.countryCode).toUpperCase().slice(0, 2) } }),
  },

  // ─── Time / timezone ─────────────────────────────────────────
  time_zone: {
    description: 'Current time and timezone info for any IANA zone (e.g. "America/Sao_Paulo", "Europe/Lisbon", "Asia/Tokyo"). Useful for scheduling across regions, DST checks.',
    parameters: { type: 'object', properties: { timeZone: { type: 'string' } }, required: ['timeZone'] },
    buildRequest: (a) => ({ params: { timeZone: a.timeZone } }),
  },

  // ─── English dictionary ──────────────────────────────────────
  dict_define_en: {
    description: 'English-only dictionary lookup with definitions, phonetics, examples, synonyms. Use for ESL learners, English content review. For Portuguese, use translate_text instead.',
    parameters: { type: 'object', properties: { word: { type: 'string' } }, required: ['word'] },
    buildRequest: (a) => ({ params: { word: String(a.word).trim().toLowerCase() } }),
  },

  // ─── GitHub repo (extends github_user) ───────────────────────
  github_repo: {
    description: 'Public GitHub repository metadata — stars, forks, language, license, description. Pass owner and repo name (e.g. owner=anthropics, repo=anthropic-sdk-typescript).',
    parameters: {
      type: 'object',
      properties: { owner: { type: 'string' }, repo: { type: 'string' } },
      required: ['owner', 'repo'],
    },
    buildRequest: (a) => ({ params: { owner: String(a.owner).trim(), repo: String(a.repo).trim() } }),
  },

  // ─── Name → age estimate ─────────────────────────────────────
  agify_name: {
    description: 'Predict likely age of a person given their first name (statistical, BR-localizable). Returns { name, age, count }. Useful for marketing segmentation, fun engagement.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        country_id: { type: 'string', description: 'Optional ISO country code (BR, US, ...) for localized data.' },
      },
      required: ['name'],
    },
    buildRequest: (a) => {
      const params: Record<string, unknown> = { name: String(a.name).trim() };
      if (a.country_id) params.country_id = String(a.country_id).toUpperCase().slice(0, 2);
      return { params };
    },
  },

  // ─── Internal Groq-powered tools (no upstream API) ───────────
  // These use llama-3.1-8b-instant directly so they don't add an external
  // dependency. Cost: ~150-300 tokens out per call, well below an LLM-
  // backed scrape+summarize chain.
  translate_text: {
    description: 'Translate any text between languages. Pass `text` and `target_lang` (e.g. "en", "pt", "es", "fr"). Auto-detects source language. Useful for multi-lingual customer support.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        target_lang: { type: 'string', description: 'Target language code (en, pt, es, fr, de, it, ja, zh, ...).' },
      },
      required: ['text', 'target_lang'],
    },
    // Internal — buildRequest unused; runtime intercepts on tool name.
  },
  detect_language: {
    description: 'Detect the language of a text. Returns ISO code (e.g. "pt", "en", "es") and confidence. Useful for routing multi-lingual conversations.',
    parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    // Internal — runtime intercepts.
  },
  summarize_url: {
    description: "Fetch a URL, extract main content, and return a short summary in Portuguese (or the user's language). Use INSTEAD of scrape_url when you don't need full text — saves tokens.",
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        max_words: { type: 'integer', description: 'Target summary length in words (default 80).' },
      },
      required: ['url'],
    },
    // Internal — chains scrape_url + groq summary.
  },
};

export function buildToolsArray(allowedTools: string[]): any[] {
  return allowedTools
    .filter((name) => SERVER_TOOLS[name] && TOOL_TO_AXON[name])
    .map((name) => ({
      type: 'function',
      function: {
        name,
        description: SERVER_TOOLS[name].description,
        parameters: SERVER_TOOLS[name].parameters,
      },
    }));
}

interface RunAgentResult {
  content: string;
  tool_calls_executed: Array<{
    name: string;
    args: Record<string, unknown>;
    ok: boolean;
    cost_usdc: string;
    error?: string;
  }>;
  iterations: number;
  finish_reason: 'stop' | 'max_iterations' | 'error';
  total_cost_usdc: string;
  /** When true, response was served from semantic cache at $0 cost. */
  cached?: boolean;
  /** Cosine similarity to cached entry (only set if cached=true). */
  cache_similarity?: number;
  /**
   * Base64-encoded images produced by tool calls (currently only generate_image
   * via Stability). Caller (e.g. the WhatsApp webhook) is responsible for
   * delivering these to the end user — they are NOT inlined into `content`,
   * which the LLM still sees as plain text.
   */
  images?: Array<{ base64: string; mimetype: string; prompt?: string }>;
  /**
   * Pix payments produced by `generate_pix` tool calls. Same out-of-band
   * delivery pattern as images — the WhatsApp webhook sends the QR PNG via
   * sendMedia plus the copy-paste EMV string as a text bubble. Multiple
   * QRs in one turn are theoretically possible but rare.
   */
  pixPayments?: Array<{
    qrCode: string;             // EMV copy-paste string
    qrCodeBase64: string;       // PNG image base64
    amountBrl: number;
    description: string;
    expiresAt?: string;
    mpId?: string;
  }>;
}

const MAX_ITERATIONS = 8;
const MAX_TOOL_RESULT_CHARS = 6000;
/** Estimated cost of a typical LLM turn — used to credit the cache for $$ saved. */
const TYPICAL_LLM_TURN_COST_MICRO = 1500n;  // ~$0.0015

/**
 * Run the agent loop server-side. Caller has already loaded the agent +
 * checked auth/budget/tier — this function focuses purely on the LLM
 * conversation + tool execution.
 */
export async function runAgent(opts: {
  c: Context;
  systemPrompt: string;
  allowedTools: string[];
  messages: ChatMessage[];
  ownerId: string;
  /** Agent ID — required for the semantic cache lookup. */
  agentId?: string;
  /** When false, skip cache lookup/store. Useful for "force fresh" debug. */
  enableCache?: boolean;
  /** Optional persona id — when set, persona.prompt_fragment is prepended
   *  to the systemPrompt. Lazy-loaded once per call. */
  personaId?: string | null;
}): Promise<RunAgentResult> {
  const { c, allowedTools, messages, ownerId, agentId, enableCache = true } = opts;
  let { systemPrompt } = opts;

  // ─── Persona loading ─────────────────────────────────────────────
  // If the agent has a persona attached, fetch its prompt_fragment and
  // prepend it BEFORE the rest of the system prompt. The fragment defines
  // the character; the existing systemPrompt has the role/business rules.
  // Done as a lazy import so non-persona runs (older agents) don't pay
  // the cost of importing the personas schema at all.
  if (opts.personaId) {
    try {
      const { db: dbm } = await import('~/db');
      const { personas } = await import('~/db/schema');
      const { eq: eqm } = await import('drizzle-orm');
      const [persona] = await dbm.select().from(personas).where(eqm(personas.id, opts.personaId)).limit(1);
      if (persona) {
        systemPrompt = persona.promptFragment + '\n\n' + systemPrompt;
      }
    } catch {/* persona load failed — continue with bare systemPrompt */}
  }

  // ─── KNOWLEDGE CACHE: try to short-circuit before calling LLM ─────────
  // Only cache when:
  //   1. We have an agentId (required for keying)
  //   2. enableCache is true (caller can disable)
  //   3. The last user message is a self-contained question
  //      (not a follow-up that depends on conversation history)
  // Conservative: skip cache when conversation has >2 turns (likely contextual).
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  const looksContextual = messages.filter((m) => m.role === 'user').length > 2;
  if (
    agentId &&
    enableCache &&
    lastUser?.content &&
    typeof lastUser.content === 'string' &&
    !looksContextual
  ) {
    const cached = await checkCache(agentId, lastUser.content).catch(() => null);
    if (cached?.hit) {
      return {
        content: cached.response,
        tool_calls_executed: [],
        iterations: 0,
        finish_reason: 'stop',
        total_cost_usdc: '0.000000',
        cached: true,
        cache_similarity: cached.similarity,
      };
    }
  }

  // ─── Smart tool selection ───────────────────────────────────────
  // Instead of dumping all 20+ tool schemas into every turn (~5k tokens
  // overhead, killing the Groq free tier), narrow to just what's relevant:
  //   1. keyword heuristic (free, ~1ms)
  //   2. LLM classifier fallback (~300ms, ~250 tokens) when keywords miss
  //   3. always-on safety net (search_web + generate_pix)
  // Only triggers when the agent has more than a handful of tools — for
  // small toolsets the overhead isn't worth the saving, and for empty
  // conversations the cache shortcut above already returned.
  let effectiveTools = allowedTools;
  if (allowedTools.length > 5 && typeof lastUser?.content === 'string' && lastUser.content.trim().length > 0) {
    const picked = await pickToolsForTurn({
      availableTools: allowedTools,
      lastUserMessage: lastUser.content,
    });
    effectiveTools = picked.tools;
  }

  const tools = buildToolsArray(effectiveTools);
  const toolList = effectiveTools
    .filter((t) => SERVER_TOOLS[t])
    .map((t) => `- ${t}: ${SERVER_TOOLS[t].description}`)
    .join('\n');

  // Time/locale awareness — lets agents say "bom dia" vs "boa noite", reference
  // weekday for scheduling, and note Brazilian-time-of-day even though servers run in UTC.
  const now = new Date();
  const isoDate = now.toISOString().slice(0, 10);
  const hourBR = (now.getUTCHours() + 24 - 3) % 24;  // BR = UTC-3
  const minBR = String(now.getUTCMinutes()).padStart(2, '0');
  const weekdayBR = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'][
    new Date(now.getTime() - 3 * 3600_000).getUTCDay()
  ];
  const greetingHint =
    hourBR < 12 ? 'bom dia' : hourBR < 18 ? 'boa tarde' : 'boa noite';

  const fullSystemPrompt = [
    systemPrompt,
    '',
    '## Language',
    "Reply in the same language the user wrote in (PT/EN/ES/etc). Mirror their language for the entire turn.",
    '',
    tools.length ? '## Tools available' : '',
    toolList,
    '',
    `Current date: ${isoDate} (${weekdayBR}, ${hourBR}h${minBR} no Brasil — saudação adequada agora: "${greetingHint}").`,
  ]
    .filter(Boolean)
    .join('\n');

  // Convo history with system prompt prepended
  const history: ChatMessage[] = [{ role: 'system', content: fullSystemPrompt }, ...messages];
  const toolCallsExecuted: RunAgentResult['tool_calls_executed'] = [];
  const generatedImages: NonNullable<RunAgentResult['images']> = [];
  const generatedPixPayments: NonNullable<RunAgentResult['pixPayments']> = [];
  let totalCostMicro = 0n;

  const groqKey = upstreamKeyFor('groq');
  if (!groqKey) {
    throw new Error('UPSTREAM_KEY_GROQ not configured — agent runtime needs Groq');
  }

  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    // Direct Groq call (we already paid the wallet via /v1/run gate)
    const llmReq: any = {
      model: 'llama-3.3-70b-versatile',
      messages: history,
      max_tokens: 4096,
      temperature: 0.3,
    };
    if (tools.length) {
      llmReq.tools = tools;
      llmReq.tool_choice = 'auto';
    }

    const llmRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + groqKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(llmReq),
    });

    if (!llmRes.ok) {
      const text = await llmRes.text().catch(() => '');
      let parsed: any = null;
      try { parsed = JSON.parse(text); } catch {}
      const m = (parsed && (parsed.message || (parsed.error && parsed.error.message))) || `groq ${llmRes.status}`;
      throw new Error(m);
    }
    const llmJson = await llmRes.json();
    const choice = llmJson.choices?.[0];
    if (!choice) throw new Error('No response from model');
    const msg: ChatMessage = choice.message ?? {};

    history.push(msg);

    const tcs = msg.tool_calls ?? [];
    if (tcs.length === 0) {
      const content = String(msg.content ?? '');

      // ─── Store in cache for future deduplication ───────────────
      // Fire-and-forget: don't block the response on cache write.
      // Skip if no agentId, no cache enabled, no question to key on, or contextual convo.
      if (
        agentId &&
        enableCache &&
        lastUser?.content &&
        typeof lastUser.content === 'string' &&
        !looksContextual &&
        content.length > 10
      ) {
        const turnCost = totalCostMicro + TYPICAL_LLM_TURN_COST_MICRO;
        // void = explicit fire-and-forget
        void storeInCache(agentId, lastUser.content, content, turnCost).catch(() => {});
      }

      return {
        content,
        tool_calls_executed: toolCallsExecuted,
        iterations: iter + 1,
        finish_reason: 'stop',
        total_cost_usdc: (Number(totalCostMicro) / 1_000_000).toFixed(6),
        ...(generatedImages.length ? { images: generatedImages } : {}),
        ...(generatedPixPayments.length ? { pixPayments: generatedPixPayments } : {}),
      };
    }

    // Execute each tool call by delegating to handleCall with explicit overrides.
    // The wallet was already conceptually committed at the agent-run gate;
    // engine still debits per-call so the costs are real.
    for (const tc of tcs) {
      let args: any;
      try { args = JSON.parse(tc.function.arguments || '{}'); } catch { args = {}; }

      // ─── Special-case: internal Groq-powered tools ─────────────────
      // translate_text / detect_language / summarize_url use llama-3.1-8b
      // directly (no upstream API). We intercept BEFORE the upstream lookup
      // so they don't fall through to handleCall.
      if (
        tc.function.name === 'translate_text' ||
        tc.function.name === 'detect_language' ||
        tc.function.name === 'summarize_url'
      ) {
        const result = await executeInternalLLMTool(tc.function.name, args, c);
        history.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: JSON.stringify(result.ok ? result.data : { error: result.error }),
        });
        toolCallsExecuted.push({
          name: tc.function.name,
          args,
          ok: result.ok,
          cost_usdc: '0',
          ...(result.ok ? {} : { error: result.error || 'unknown' }),
        });
        continue;
      }

      // ─── Special-case: generate_pix ─────────────────────────────────
      // Doesn't go through handleCall (no upstream API in the registry).
      // Calls our internal MercadoPago wrapper, persists a pix_payments row
      // (so the existing webhook flow credits the owner when paid), and
      // surfaces the QR for out-of-band delivery (similar to generate_image).
      if (tc.function.name === 'generate_pix') {
        const pixResult = await executePixTool({ args, ownerId, agentId });
        if (pixResult.ok) {
          generatedPixPayments.push(pixResult.payment!);
          history.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: JSON.stringify({
              ok: true,
              amount_brl: pixResult.payment!.amountBrl,
              description: pixResult.payment!.description,
              note: 'Pix QR will be delivered to the customer automatically. Confirm in PT-BR.',
            }),
          });
          toolCallsExecuted.push({ name: 'generate_pix', args, ok: true, cost_usdc: '0' });
        } else {
          history.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: JSON.stringify({ error: pixResult.error }),
          });
          toolCallsExecuted.push({
            name: 'generate_pix', args, ok: false, cost_usdc: '0', error: pixResult.error,
          });
        }
        continue;
      }

      const upstream = TOOL_TO_AXON[tc.function.name];
      const def = SERVER_TOOLS[tc.function.name];
      if (!upstream || !def) {
        const err = `Tool '${tc.function.name}' is not server-runnable.`;
        toolCallsExecuted.push({ name: tc.function.name, args, ok: false, cost_usdc: '0', error: err });
        history.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify({ error: err }) });
        continue;
      }
      // The internal __internal__ marker means "registered for buildToolsArray
      // but not a real upstream call" — should have been handled above; if we
      // get here, the tool name has no special branch and is misconfigured.
      if (upstream.api === '__internal__') {
        const err = `Tool '${tc.function.name}' is internal-only and has no executor.`;
        toolCallsExecuted.push({ name: tc.function.name, args, ok: false, cost_usdc: '0', error: err });
        history.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify({ error: err }) });
        continue;
      }

      const built = def.buildRequest ? def.buildRequest(args) : { params: args };

      try {
        const upstreamRes = await handleCall(c, {
          slug: upstream.api,
          endpoint: upstream.endpoint,
          paramsOverride: built.params ?? {},
          bodyOverride: built.body,
        });
        const cost = parseFloat(upstreamRes.headers.get('x-axon-cost-usdc') || '0') || 0;
        totalCostMicro += BigInt(Math.round(cost * 1_000_000));
        const cloned = upstreamRes.clone();
        const text = await cloned.text();

        // ─── Special-case: generate_image returns raw base64 PNG(s) which
        // would (a) blow up the LLM context window and (b) confuse the model
        // since it can't actually look at the bytes. Extract the artifact(s)
        // for out-of-band delivery (the WhatsApp webhook will sendMedia them)
        // and feed the LLM only a short confirmation summary.
        let truncated = text.slice(0, MAX_TOOL_RESULT_CHARS);
        if (tc.function.name === 'generate_image' && upstreamRes.ok) {
          try {
            const parsed = JSON.parse(text);
            const artifacts = Array.isArray(parsed?.artifacts) ? parsed.artifacts : [];
            for (const art of artifacts) {
              if (art && typeof art.base64 === 'string' && art.base64.length > 0) {
                generatedImages.push({
                  base64: art.base64,
                  mimetype: 'image/png',
                  prompt: typeof args.prompt === 'string' ? args.prompt : undefined,
                });
              }
            }
            // Replace the gigantic base64 with a tiny summary the LLM can reason about.
            truncated = JSON.stringify({
              ok: true,
              images_generated: generatedImages.length,
              note: 'Image(s) will be sent to the user via the channel automatically.',
            });
          } catch {
            // If parsing fails, keep the truncated raw text — better than nothing.
          }
        }

        toolCallsExecuted.push({
          name: tc.function.name,
          args,
          ok: upstreamRes.ok,
          cost_usdc: cost.toFixed(6),
        });
        history.push({ role: 'tool', tool_call_id: tc.id, content: truncated });
      } catch (err: any) {
        toolCallsExecuted.push({
          name: tc.function.name,
          args,
          ok: false,
          cost_usdc: '0',
          error: err.message || String(err),
        });
        history.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: JSON.stringify({ error: err.message || String(err) }),
        });
      }
    }
    // Loop continues — model gets the tool results and may call more tools or finalize
  }

  return {
    content: '(max iterations reached without final answer)',
    tool_calls_executed: toolCallsExecuted,
    iterations: MAX_ITERATIONS,
    finish_reason: 'max_iterations',
    total_cost_usdc: (Number(totalCostMicro) / 1_000_000).toFixed(6),
    ...(generatedImages.length ? { images: generatedImages } : {}),
    ...(generatedPixPayments.length ? { pixPayments: generatedPixPayments } : {}),
  };
}

/**
 * Executes the generate_pix tool: creates a real Pix payment via MercadoPago,
 * persists a pix_payments row (so the existing /v1/webhooks/mercadopago flow
 * credits the agent owner when the customer pays), and returns the QR data
 * for out-of-band delivery on the channel (WhatsApp / web).
 *
 * Owner-funded: the Pix is created under the agent OWNER's pix_payments row,
 * with metadata noting the source ('chat_generated') and agent_id. When the
 * customer pays via Pix, MP webhook → credit() → owner's USDC wallet bumps.
 *
 * Lazy-imports MP wrapper + DB so we don't pay the import cost on every
 * agent run that doesn't use Pix (most of them).
 */
/**
 * Execute one of the internal Groq-powered tools (translate_text,
 * detect_language, summarize_url). They all share the same shape: take
 * args, call llama-3.1-8b-instant with a small prompt, return JSON.
 *
 * No external API key required (Groq key is already needed for the agent
 * runtime itself). Costs nothing extra beyond ~150-300 tokens per call.
 *
 * Returns ok:true with the data the tool description promised, or ok:false
 * with an error string the LLM can show to the user.
 */
async function executeInternalLLMTool(
  name: string,
  args: any,
  _c: Context,
): Promise<{ ok: true; data: any } | { ok: false; error: string }> {
  const groqKey = upstreamKeyFor('groq');
  if (!groqKey) return { ok: false, error: 'Groq key not configured.' };

  // Cap the input so a malicious or runaway prompt can't burn the daily TPM.
  const cap = (s: unknown, n = 4000) => String(s ?? '').slice(0, n);

  let systemPrompt: string;
  let userInput: string;
  let maxTokens = 300;
  let parser: (raw: string) => any = (r) => ({ result: r.trim() });

  if (name === 'translate_text') {
    const target = String(args.target_lang || 'pt').slice(0, 8);
    systemPrompt =
      `You are a translator. Translate the user's text into "${target}". ` +
      `Output ONLY the translation — no preamble, no explanation, no quotes around it.`;
    userInput = cap(args.text, 3000);
    maxTokens = 600;
    parser = (r) => ({ translation: r.trim(), target_lang: target });
  } else if (name === 'detect_language') {
    systemPrompt =
      'Detect the ISO 639-1 language code of the user\'s text. ' +
      'Output ONLY the 2-letter code in lowercase (e.g. "pt", "en", "es"). No other text.';
    userInput = cap(args.text, 1000);
    maxTokens = 8;
    parser = (r) => {
      const code = r.trim().toLowerCase().slice(0, 2);
      return { language: code };
    };
  } else if (name === 'summarize_url') {
    // Chain: scrape via firecrawl tool (uses configured key) → summarize.
    // We do the scrape inline rather than recursing into handleCall to keep
    // this self-contained and skip the wrapper's per-call billing path.
    const url = cap(args.url, 800);
    if (!/^https?:\/\//.test(url)) {
      return { ok: false, error: 'url must start with http:// or https://' };
    }
    let pageText = '';
    try {
      // Cheap fetch with a 12s timeout — better to give up than block the
      // user-facing reply for a slow page.
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 12_000);
      const r = await fetch(url, {
        signal: ctrl.signal,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AxonAgent/1.0)' },
      });
      clearTimeout(t);
      if (!r.ok) return { ok: false, error: `fetch ${r.status}` };
      const html = await r.text();
      // Strip HTML aggressively — we want substance, not formatting. The
      // model can summarize from rough text just fine.
      pageText = html
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 8000);
    } catch (err: any) {
      return { ok: false, error: `fetch failed: ${err.message || String(err)}` };
    }
    if (pageText.length < 100) {
      return { ok: false, error: 'page returned too little text to summarize' };
    }
    const maxWords = Math.max(20, Math.min(args.max_words || 80, 300));
    systemPrompt =
      `Você é um sumarizador. Resuma o conteúdo da página em PT-BR em ` +
      `aproximadamente ${maxWords} palavras. Foque no essencial; ignore ` +
      `navegação, propaganda e rodapé. Não invente.`;
    userInput = pageText;
    maxTokens = Math.min(800, maxWords * 4);
    parser = (r) => ({ summary: r.trim(), source_url: url });
  } else {
    return { ok: false, error: `unknown internal tool: ${name}` };
  }

  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + groqKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'llama-3.1-8b-instant',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userInput },
        ],
        max_tokens: maxTokens,
        temperature: 0.2,
      }),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      return { ok: false, error: `groq ${res.status}: ${t.slice(0, 200)}` };
    }
    const json: any = await res.json().catch(() => null);
    const content = String(json?.choices?.[0]?.message?.content || '');
    return { ok: true, data: parser(content) };
  } catch (err: any) {
    return { ok: false, error: err.message || String(err) };
  }
}

async function executePixTool(opts: {
  args: any;
  ownerId: string;
  agentId?: string;
}): Promise<{
  ok: boolean;
  payment?: NonNullable<RunAgentResult['pixPayments']>[number];
  error?: string;
}> {
  const amount = Number(opts.args?.amount_brl);
  const description = String(opts.args?.description || '').slice(0, 200);
  if (!Number.isFinite(amount) || amount < 0.5 || amount > 5000) {
    return { ok: false, error: 'amount_brl must be between 0.50 and 5000' };
  }
  if (!description) {
    return { ok: false, error: 'description is required' };
  }

  try {
    const { createPixPayment } = await import('~/payment/mercadopago');
    const { db: dbm } = await import('~/db');
    const { pixPayments, users } = await import('~/db/schema');
    const { eq: eqm } = await import('drizzle-orm');

    // Pre-create row to use as MP external_reference (correlates the webhook).
    const [row] = await dbm
      .insert(pixPayments)
      .values({
        userId: opts.ownerId,
        mpPaymentId: 'pending',
        amountBrl: amount.toFixed(2),
        status: 'pending',
        meta: {
          source: 'chat_generated',
          agent_id: opts.agentId ?? null,
          description,
        },
      })
      .returning();

    // Owner email is required by MP for any Pix. Fall back to a deterministic
    // synthetic if the user has none — works fine, MP only validates format.
    const [owner] = await dbm.select().from(users).where(eqm(users.id, opts.ownerId)).limit(1);
    const payerEmail = owner?.email || `${opts.ownerId}@axon.user`;

    const result = await createPixPayment({
      amountBrl: amount,
      externalReference: row.id,
      description: `Axon · ${description}`.slice(0, 200),
      payerEmail,
      idempotencyKey: row.id,
      expiresInMinutes: 30,
    });

    if (!result.ok) {
      // Roll back the placeholder row so we don't leak orphaned pending rows.
      await dbm.delete(pixPayments).where(eqm(pixPayments.id, row.id));
      return { ok: false, error: result.error };
    }

    await dbm
      .update(pixPayments)
      .set({
        mpPaymentId: result.mpId!,
        qrCode: result.qrCode,
        qrCodeBase64: result.qrCodeBase64,
        ticketUrl: result.ticketUrl,
        expiresAt: result.expiresAt ? new Date(result.expiresAt) : null,
        updatedAt: new Date(),
      })
      .where(eqm(pixPayments.id, row.id));

    return {
      ok: true,
      payment: {
        qrCode: result.qrCode!,
        qrCodeBase64: result.qrCodeBase64!,
        amountBrl: amount,
        description,
        expiresAt: result.expiresAt,
        mpId: result.mpId,
      },
    };
  } catch (err: any) {
    return { ok: false, error: err.message || String(err) };
  }
}
