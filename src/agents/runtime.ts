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
import { chatCompletionWithFallback } from '~/llm/fallback';

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

/**
 * Tools every agent gets for free regardless of template. They cost
 * nothing on their own (catalog is in-memory, photo is a URL forwarded
 * to Evolution, PDF is rendered locally) so they're always-on. Source
 * of truth for the universal-tool list — both the WhatsApp channel and
 * the cache versioning import this so they can never drift apart.
 */
export const UNIVERSAL_TOOL_NAMES = ['search_catalog', 'send_listing_photo', 'send_catalog_pdf'] as const;

/**
 * Plain-text snapshot of the system rules that govern tool use. Hashed
 * (with the universal-tool list) into the cache version key so any
 * change to either invalidates stale cached responses on next deploy.
 *
 * Edit this when you change the rules text below in qualityRule — keep
 * the two in sync. Mismatch is harmless (older cache hits keep coming
 * through) but defeats the purpose.
 */
export const CORE_RULES_TEXT = `## Regras de tool-use (NUNCA viole)
1. NUNCA invente dado pra preencher tool.
2. NUNCA escreva o markup da tool no texto.
2b. NUNCA escreva placeholders entre colchetes ([CATÁLOGO COMPLETO], [FOTO], [PDF], [ARQUIVO], [IMAGEM AQUI], [VEJA AS FOTOS], [LINK DO CATÁLOGO]). Mídia chega via tool, não via placeholder.
3. Tool falhou ou retornou vazio? Diga ao cliente, não invente.
4. Catálogo COMPLETO = send_catalog_pdf (sem args, pega do cadastro).
4b. PDF de SUBCONJUNTO filtrado = search_catalog + generate_pdf (max 8 itens).
5. Foto de item = search_catalog + send_listing_photo (max 3, com image_url real).
v4 — fix critical bug: special-case tools (search_catalog, send_listing_photo, send_catalog_pdf, generate_pdf, schedule_appointment) were being filtered out of the LLM's tool list because they weren't in TOOL_TO_AXON. They are now. Without this, every "manda foto" / "manda catálogo" / "search the inventory" turn was a hallucination because the model literally couldn't see the tool.
`;

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
  search_catalog: {
    description:
      'Search the agent owner\'s uploaded inventory catalog (cars, properties, products, anything the operator cataloged). Returns matching items as the source of truth — use BEFORE suggesting any item to the customer, never invent inventory. Returns up to 10 items ranked by relevance. Search across name, region, description, and any custom metadata fields. Returns empty array if no catalog uploaded or no matches.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Free-form search — model, region, price range words, anything the customer mentioned. E.g. "tatuapé 2 quartos", "Onix usado", "ração filhote".' },
        limit: { type: 'integer', description: 'Max items (default 10).' },
      },
      required: ['query'],
    },
    // No buildRequest — intercepted in the runtime special-case below.
  },
  send_listing_photo: {
    description:
      'Send a real photo of a catalog item (property, car, product) to the customer via WhatsApp. Use this when the customer asks for "fotos", "imagens", "foto da casa", "manda a foto" — or when showing items where you want the photo to land. ALWAYS call search_catalog first to get the actual image_url from the inventory. Maximum 3 photos per turn (avoids spam). Returns ok:true when queued. NEVER write "[FOTOS]" or "*FOTO*" placeholders in your reply — call this tool to deliver real photos.',
    parameters: {
      type: 'object',
      properties: {
        image_url: { type: 'string', description: 'The public image_url returned by search_catalog for the item. Must start with http(s)://' },
        caption: { type: 'string', description: 'Optional short caption (≤200 chars) shown below the photo — usually the listing name + price.' },
      },
      required: ['image_url'],
    },
    // No buildRequest — intercepted in the runtime special-case below.
  },
  send_catalog_pdf: {
    description:
      'Send the FULL catalog as a polished PDF (cover page + 2-col grid with photos) to the customer over WhatsApp. Use this when the customer asks for the WHOLE catalog — "tem catálogo?", "me manda o catálogo", "manda a lista completa", "mostra tudo que vocês têm", "quais imóveis vocês têm". DO NOT use for a single item — for one specific listing call send_listing_photo instead. Takes no arguments; the catalog comes from the agent\'s configuration. The PDF is delivered automatically; just confirm in PT-BR (e.g. "Pronto, te mandei o catálogo completo aqui 📄").',
    parameters: { type: 'object', properties: {} },
    // No buildRequest — intercepted in the runtime special-case below.
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
  schedule_appointment: {
    description:
      'Schedule a customer appointment. Call this when you and the customer have AGREED on a specific date and time. The system will automatically send the customer a reminder one day before the appointment via WhatsApp. ' +
      'Required: scheduled_for_iso (ISO 8601 timestamp WITH timezone, e.g. "2026-05-04T13:00:00-03:00") and description (e.g. "Consulta com Dra. Elisa"). ' +
      'Optional: duration_minutes (default 30), location (address/room). ' +
      'Customer phone is taken automatically from the WhatsApp context. ' +
      'After calling this, confirm the booking to the customer in PT-BR — e.g. "Pronto, agendamento confirmado pra [data], qualquer coisa só me chamar."',
    parameters: {
      type: 'object',
      properties: {
        scheduled_for_iso: {
          type: 'string',
          description: 'ISO 8601 datetime with timezone offset (e.g. "2026-05-04T13:00:00-03:00" for Brazilian time).',
        },
        description: {
          type: 'string',
          description: 'Short label, e.g. "Consulta clínica geral", "Corte de cabelo + barba", "Visita ao imóvel".',
        },
        duration_minutes: {
          type: 'integer',
          description: 'Duration in minutes. Defaults to 30 if omitted.',
        },
        location: {
          type: 'string',
          description: 'Optional address, room, or video link.',
        },
      },
      required: ['scheduled_for_iso', 'description'],
    },
    // No buildRequest — handled in the runtime special-case (DB insert).
  },
  generate_pdf: {
    description:
      'Generate a PDF document and deliver it to the customer over WhatsApp. ' +
      'Use for: comprovante de agendamento, ficha de cadastro, recibo, ' +
      'orientação pré-consulta, contrato, declaração, receita virtual. ' +
      'Always write content in PT-BR. Title should be specific (ex: "Comprovante de Agendamento"). ' +
      'Body is the high-signal first paragraph. Sections are optional structured blocks for repeated key/value pairs (paciente, data, endereço, valor). ' +
      'The PDF is delivered automatically — you only need to confirm to the customer in PT-BR.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Bold title at top (e.g. "Comprovante de Agendamento").' },
        body: { type: 'string', description: 'First paragraph — concise summary of what the document confirms.' },
        sections: {
          type: 'array',
          description: 'Optional structured sections (label + value blocks).',
          items: {
            type: 'object',
            properties: {
              heading: { type: 'string', description: 'Short label, e.g. "Paciente", "Data", "Valor".' },
              content: { type: 'string', description: 'The corresponding value or info.' },
            },
            required: ['heading', 'content'],
          },
        },
        doc_type_hint: {
          type: 'string',
          enum: [
            'comprovante_gerado',
            'agendamento_gerado',
            'ficha_gerada',
            'contrato_gerado',
            'receita_gerada',
            'recibo_gerado',
            'orientacao_gerada',
            'outro_gerado',
          ],
          description: 'Best-fit category for the document being generated.',
        },
      },
      required: ['title', 'body'],
    },
    // No buildRequest — handled in the runtime special-case (renderPdf).
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

  // ─── Sub-endpoints of existing providers (already in registry) ──

  /** Full list of Brazilian banks (FEBRABAN-registered). Heavy — only call
   *  when the user wants the whole list, not for one bank lookup. */
  list_banks_br: {
    description: 'List ALL Brazilian banks (200+ institutions). Returns code, name, ispb, fullName. Use only when the user asks for the full list — for one bank, use lookup_bank instead.',
    parameters: { type: 'object', properties: {} },
    buildRequest: () => ({ params: {} }),
  },

  /** FIPE brand list per vehicle type. Required step BEFORE lookup_fipe to
   *  get the codigoFipe (you need brand → model → year → codigo chain). */
  fipe_brands: {
    description: 'List FIPE brands (marcas) for a vehicle type. tipoVeiculo: 1=carros, 2=motos, 3=caminhões. Use this to find a brand id, then chain to model/year/code lookup.',
    parameters: {
      type: 'object',
      properties: {
        tipoVeiculo: { type: 'integer', enum: [1, 2, 3], description: '1=carros, 2=motos, 3=caminhões.' },
      },
      required: ['tipoVeiculo'],
    },
    buildRequest: (a) => ({ params: { tipoVeiculo: a.tipoVeiculo } }),
  },

  github_search_repos: {
    description: 'Search public GitHub repositories. Build queries like "react language:typescript stars:>10000" or "claude api topic:llm". Sort by stars (default), forks, updated.',
    parameters: {
      type: 'object',
      properties: {
        q: { type: 'string', description: 'GitHub search query.' },
        sort: { type: 'string', enum: ['stars', 'forks', 'updated'], description: 'Default stars.' },
        per_page: { type: 'integer', description: 'Default 10, max 30.' },
      },
      required: ['q'],
    },
    buildRequest: (a) => ({
      params: { q: a.q, sort: a.sort || 'stars', order: 'desc', per_page: Math.min(a.per_page || 10, 30) },
    }),
  },

  ibge_states: {
    description: 'List all 27 Brazilian states (and DF). Returns id, sigla (UF), nome, region. Useful for dropdowns, region grouping, validation.',
    parameters: { type: 'object', properties: {} },
    buildRequest: () => ({ params: {} }),
  },

  ibge_cities_search: {
    description: 'Full list of all 5,570 Brazilian municipalities. HEAVY (~600KB). Prefer ibge_city by id when possible. Use when needing to grep multiple cities at once.',
    parameters: { type: 'object', properties: {} },
    buildRequest: () => ({ params: {} }),
  },

  book_search: {
    description: 'Search books by title, author, subject. Returns title, authors, first publish year, ISBNs, OL key. Useful for libraries, bookstores, research.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'integer', description: 'Default 10, max 50.' },
      },
      required: ['query'],
    },
    buildRequest: (a) => ({ params: { q: a.query, limit: Math.min(a.limit || 10, 50) } }),
  },

  reverse_geocode: {
    description: 'Reverse geocoding — convert lat/lon coordinates back to a formatted address. Pair with route_distance results for human-readable trip endpoints.',
    parameters: {
      type: 'object',
      properties: { lat: { type: 'number' }, lon: { type: 'number' } },
      required: ['lat', 'lon'],
    },
    buildRequest: (a) => ({
      params: { lat: a.lat, lon: a.lon, format: 'json', addressdetails: 1, zoom: 18 },
    }),
  },

  mercadolivre_item: {
    description: 'Detailed Mercado Livre item by id (MLB1234567890). Use AFTER mercadolivre_search to get full description, seller stats, shipping options.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Item id, e.g. MLB1234567890.' } },
      required: ['id'],
    },
    buildRequest: (a) => ({ params: { id: String(a.id).trim() } }),
  },

  wikipedia_related: {
    description: 'Up to 20 pages related to a Wikipedia article. Useful for "see also" workflows, knowledge graph traversal, finding adjacent topics.',
    parameters: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] },
    buildRequest: (a) => ({ params: { title: String(a.title).replace(/ /g, '_') } }),
  },

  // ─── New free APIs (no key) ──────────────────────────────────

  reddit_search: {
    description: 'Search Reddit posts across all subreddits. Returns title, subreddit, score, author, permalink. Useful for sentiment, trends, real-user feedback on products/topics.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        sort: { type: 'string', enum: ['relevance', 'hot', 'top', 'new'], description: 'Default relevance.' },
        limit: { type: 'integer', description: 'Default 10, max 25.' },
      },
      required: ['query'],
    },
    buildRequest: (a) => ({
      params: { q: a.query, sort: a.sort || 'relevance', limit: Math.min(a.limit || 10, 25) },
    }),
  },

  stackoverflow_search: {
    description: 'Search Stack Overflow questions. Returns title, score, view count, has-accepted-answer, link. Useful for technical Q&A, debugging help, documentation lookups.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        tags: { type: 'string', description: 'Optional tag filter (e.g. "python;django").' },
        pagesize: { type: 'integer', description: 'Default 5, max 30.' },
      },
      required: ['query'],
    },
    buildRequest: (a) => {
      const params: Record<string, unknown> = {
        q: a.query,
        site: 'stackoverflow',
        order: 'desc',
        sort: 'votes',
        pagesize: Math.min(a.pagesize || 5, 30),
      };
      if (a.tags) params.tagged = String(a.tags).replace(/,/g, ';');
      return { params };
    },
  },

  wikidata_search: {
    description: 'Search Wikidata entities (people, places, concepts). Returns Q-ids and short descriptions. Use to disambiguate names ("which Donald?") or find structured facts complementing Wikipedia.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        language: { type: 'string', description: 'Default pt.' },
      },
      required: ['query'],
    },
    buildRequest: (a) => ({
      params: {
        action: 'wbsearchentities',
        search: a.query,
        language: a.language || 'pt',
        format: 'json',
        origin: '*',
        limit: 8,
      },
    }),
  },

  wttr_weather: {
    description: 'Quick weather lookup via wttr.in. Pass any city name, airport (IATA), or "@username" for self-located. Returns multi-day forecast in JSON. Lighter than current_weather, no key.',
    parameters: {
      type: 'object',
      properties: { location: { type: 'string', description: 'City, airport code, or coords "lat,lon".' } },
      required: ['location'],
    },
    buildRequest: (a) => ({ params: { location: String(a.location).trim(), format: 'j1' } }),
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
    /** Wall-clock duration of the upstream call in ms (best effort). */
    ms?: number;
    /** First 280 chars of the upstream response — surfaced in the brain
     *  panel so the operator can see what the tool actually returned
     *  without diving into raw history. */
    response_excerpt?: string;
    /** HTTP status from the upstream call. */
    status?: number;
  }>;
  iterations: number;
  finish_reason: 'stop' | 'max_iterations' | 'error';
  total_cost_usdc: string;
  /** When true, response was served from semantic cache at $0 cost. */
  cached?: boolean;
  /** Cosine similarity to cached entry (only set if cached=true). */
  cache_similarity?: number;
  /** Subset of allowedTools the smart selector exposed for this turn.
   *  Equal to allowedTools when no narrowing happened. */
  tools_offered?: string[];
  /** Provider that generated the FINAL assistant message. Useful for
   *  the brain UI ("groq" / "gemini" / "cohere") and the judge layer. */
  provider?: string;
  /** Total wall-clock duration of runAgent() in ms — start to finish, including
   *  cache lookup, LLM calls, and tool calls. */
  latency_ms?: number;
  /** Hash of the system rules + universal-tool list this turn ran on.
   *  Logged + surfaced in the Brain panel so unexpected behavior can be
   *  matched to a deploy ("ah, that ran on rules-vY"). Cache entries are
   *  partitioned by this same key, so a deploy that changes the rules
   *  invalidates stale FAQ hits automatically. */
  rules_version?: string;
  /**
   * Images produced by tool calls. Two source flavors:
   *   - generate_image (Stability): base64 + mimetype
   *   - send_listing_photo (catalog): public URL from the catalog item
   * Caller (e.g. the WhatsApp webhook) is responsible for delivering these
   * to the end user — they are NOT inlined into `content`, which the LLM
   * still sees as plain text.
   */
  images?: Array<{ base64?: string; url?: string; mimetype: string; prompt?: string; caption?: string }>;
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
  /**
   * PDFs produced by `generate_pdf` tool calls. Caller (the WhatsApp
   * webhook) is responsible for sending them via Evolution sendMedia
   * (mediatype:'document') and persisting to contact_documents with
   * direction='outbound'. The LLM only sees a confirmation result; it
   * doesn't get the bytes back to read.
   */
  pdfs?: Array<{
    base64: string;
    filename: string;
    title: string;
    docType: string;
    /** Cap'd version of the body for downstream summary persistence. */
    excerpt: string;
  }>;
}

const MAX_ITERATIONS = 8;
const MAX_TOOL_RESULT_CHARS = 6000;
/** Estimated cost of a typical LLM turn — used to credit the cache for $$ saved. */
const TYPICAL_LLM_TURN_COST_MICRO = 1500n;  // ~$0.0015

/**
 * Per-turn LLM debit — every non-cached agent reply takes this much
 * from the owner's wallet. Tools are billed separately on top. Default
 * is 1500 micro ($0.0015), overridable via env LLM_TURN_COST_MICRO so
 * the operator can dial it up/down without a redeploy.
 *
 * Why per-turn billing exists: subscription is cheap monthly + good
 * % markup on APIs. Without per-turn, conversation traffic is free
 * to the platform — owner's wallet only depletes when an actual
 * upstream tool fires. With per-turn, every reply contributes, so
 * the math closes even on a chatty agent that doesn't call tools.
 */
function getLlmTurnCostMicro(): bigint {
  const raw = process.env.LLM_TURN_COST_MICRO;
  if (!raw) return TYPICAL_LLM_TURN_COST_MICRO;
  try {
    const n = BigInt(raw);
    return n >= 0n ? n : TYPICAL_LLM_TURN_COST_MICRO;
  } catch {
    return TYPICAL_LLM_TURN_COST_MICRO;
  }
}

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
  const t0 = Date.now();

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
      // Cache hits ARE billed — they're pure margin for the operator
      // (no upstream LLM cost, customer gets a real reply). Charged at
      // the same rate as a regular turn by default; tune via env
      // LLM_CACHE_HIT_COST_MICRO to discount cache turns separately
      // if you want to advertise "cache custa menos" later.
      const cacheCost = (() => {
        const raw = process.env.LLM_CACHE_HIT_COST_MICRO;
        if (raw) {
          try { const n = BigInt(raw); if (n >= 0n) return n; } catch { /* fall through */ }
        }
        return getLlmTurnCostMicro();
      })();
      let actualBilledMicro = 0n;
      if (cacheCost > 0n && ownerId) {
        try {
          const { debit } = await import('~/wallet/service');
          await debit({
            userId: ownerId,
            amountMicro: cacheCost,
            type: 'debit',
            meta: {
              purpose: 'agent_turn',
              agent_id: agentId,
              cache_hit: true,
              cache_similarity: cached.similarity,
            },
          });
          actualBilledMicro = cacheCost;
        } catch (err) {
          const { log } = await import('~/lib/logger');
          log.warn('agent.turn_debit.failed', {
            agent_id: agentId,
            owner_id: ownerId,
            cost_micro: cacheCost.toString(),
            cache_hit: true,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      return {
        content: cached.response,
        tool_calls_executed: [],
        iterations: 0,
        finish_reason: 'stop',
        total_cost_usdc: (Number(actualBilledMicro) / 1_000_000).toFixed(6),
        cached: true,
        cache_similarity: cached.similarity,
        latency_ms: Date.now() - t0,
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

  // Universal quality rule — applies to every agent regardless of
  // template. Born from a real failure: 3 conversations with the live
  // Concessionária ended with 0 tool calls and pure deflection ("qual
  // modelo?" / "como posso ajudar?"). The fix isn't another template
  // tweak — it's a non-negotiable house rule that every reply must
  // either move the deal forward with real data OR ask one sharp
  // question that unlocks a tool call next turn. Kept tight (Llama
  // tunes out long preambles) and ordered AFTER the persona so the
  // template's domain knowledge wins on conflict.
  const qualityRule = tools.length
    ? `## Regra de qualidade (não-negociável)
Cada resposta sua deve conter UMA dessas duas coisas — nunca nenhuma:
  (a) dado real puxado de tool (FIPE, CEP, mercadolivre, weather, search…),
  (b) UMA pergunta sharp que destrava tool no próximo turno.

Se a resposta não tem (a) nem (b), reformula antes de mandar.
"Como posso ajudar?" / "Qual sua dúvida?" / "Em que posso te auxiliar?" são PROIBIDAS — elas não destravam nada.

Se o cliente é vago ("quanto custa", "tem barato"), NÃO devolve outra pergunta vaga. Faz UMA pergunta sharp + JÁ chama a tool com chute razoável: "Qual modelo? FIPE na hora" / "Te puxo opções até R$X" / etc.

Se você JÁ tem business_info (endereço, horário, catálogo, política), USA antes de perguntar. Repetir pergunta que tá no business_info = bot ruim.

**REGRA DE FOLLOW-UP CURTO**: Se na última mensagem você perguntou algo (orçamento, modelo, CEP, região…) e o cliente respondeu CURTO ("2 mil", "Civic", "01001", "qualquer", "tanto faz", "Itaim") — TRATA isso como a resposta da sua pergunta e SEGUE EM FRENTE com a próxima ação. Re-perguntar a mesma coisa porque a resposta foi curta = bot quebrado. "2 mil" depois de "qual orçamento" = R$ 2.000, sem segunda pergunta. "qualquer" depois de "qual região" = remove o filtro de região e busca tudo.

## Regras de tool-use (NUNCA viole)
1. **NUNCA invente dado pra preencher tool.** Se a tool precisa de CEP, CNPJ, modelo de carro, link, e o cliente NÃO disse — VOCÊ PERGUNTA antes. Não chama lookup_cep com "01001-000" só pra ter algo. Não chama lookup_fipe com "Civic" se cliente só falou "carro". Cada chamada custa dinheiro do dono — desperdício é proibido.
2. **NUNCA escreva o markup da tool no texto.** Markup tipo \`<function=name>{...}</function>\` ou \`{"name": "...", "arguments": {...}}\` é INTERNO — sai pelo canal de tool_calls do LLM, NÃO no campo content. Se você se pegar querendo escrever isso no texto, RECOMECE a resposta sem o markup.
2b. **NUNCA escreva placeholders entre colchetes** como \`[CATÁLOGO COMPLETO DE IMÓVEIS]\`, \`[FOTO]\`, \`[FOTO DA FACHADA]\`, \`[PDF]\`, \`[ARQUIVO]\`, \`[IMAGEM AQUI]\`, \`[VEJA AS FOTOS]\`, \`[LINK DO CATÁLOGO]\`. Isso é placeholder humano de quem ainda não construiu o sistema — não é como mídia funciona aqui. Mídia (foto/PDF/áudio) só chega pro cliente se você **CHAMA A TOOL** (\`send_listing_photo\`, \`send_catalog_pdf\`, \`generate_pdf\`). Se a tool não existe pra esse caso, descreve em texto natural ("posso te enviar o catálogo agora, segura aí") SEM colchetes — e CHAMA a tool no mesmo turno. Texto entre colchetes = você quebrando a ilusão e o cliente vai sentir que é bot mal feito.
3. **Tool falhou ou retornou vazio?** Diz pro cliente honesto ("não achei o CEP, confirma os 8 dígitos?") em vez de inventar a resposta como se tivesse dado.
4. **Catálogo COMPLETO = \`send_catalog_pdf\`.** Quando o cliente pede pra ver TUDO ("tem catálogo?", "me manda o catálogo", "manda a lista completa", "mostra tudo que vocês têm", "quais imóveis vocês têm", "quero ver os carros"), você chama \`send_catalog_pdf\` (sem argumentos — ele já pega do cadastro). É um PDF profissional com capa, fotos e todos os itens organizados em grade. NUNCA use \`generate_pdf\` (que é pra documentos avulsos) ou \`search_catalog\` + \`generate_pdf\` pra esse caso — tem ferramenta dedicada melhor.
4b. **PDF de SUBCONJUNTO filtrado** (cliente quer um recorte, ex: "manda em PDF só as casas até 500 mil em Tabatinga"). Aí sim: \`search_catalog\` com a query + \`generate_pdf\` com \`sections\` (max 8 itens, formato sucinto). Esse caminho é exceção; o caso comum é o catálogo inteiro via \`send_catalog_pdf\`.
   Se o catálogo estiver vazio em qualquer dos dois, fala "ainda não temos itens cadastrados aqui, mas anota seu interesse e te aviso assim que entrar" em vez de gerar PDF vazio.
5. **Foto de item do catálogo = encadeamento obrigatório.** Quando o cliente pede "manda foto", "tem foto?", "me mostra a casa", "quero ver imagens", você FAZ DOIS PASSOS no MESMO turno:
   (i) chama \`search_catalog\` com a query (ex: "casa Martin de Sá") pra pegar o \`image_url\` real do item,
   (ii) chama \`send_listing_photo\` UMA VEZ por foto (max 3) passando o \`image_url\` retornado e um \`caption\` curto (nome + preço).
   PROIBIDO escrever "*FOTOS*", "[FOTO DA FACHADA]", "[FOTO DO APARTAMENTO NO CENTRO]", "vou enviar as fotos", "Aqui está a foto:" como TEXTO sem chamar \`send_listing_photo\` no mesmo turno. Sem image_url no item? Diz honesto: "esse não tem foto cadastrada, mas a descrição é X" em vez de fingir que vai enviar.

## Formato de saída no WhatsApp (obrigatório)
- **Bolhas curtas, separadas por \`||\`.** Resposta natural no zap = 2-3 bolhas de 1-2 frases cada. NUNCA mande um parágrafo de 5 linhas — fica robótico e o cliente bate o olho e some.
- Exemplo CERTO: \`Boa noite! 👋 || Pra te ajudar a achar o imóvel certo, qual cidade ou bairro?\`
- Exemplo ERRADO (parede de texto): \`Boa noite! Pra te ajudar a achar o imóvel certo, eu preciso entender melhor o que você procura, então me diz qual cidade ou bairro você tem interesse, e também o orçamento aproximado, e quantos quartos.\`
- Cada bolha = UMA ideia. Acolhimento numa, pergunta na próxima, dado/preço numa terceira.
- Limite: máximo 3 bolhas por resposta. Se precisa mais que isso, você tá perguntando demais — corta.
- NUNCA invente preço, endereço, propriedade, marca, especificação que você não puxou de tool. Inventar = quebra de confiança.`
    : '';

  const fullSystemPrompt = [
    systemPrompt,
    '',
    '## Language',
    "Reply in the same language the user wrote in (PT/EN/ES/etc). Mirror their language for the entire turn.",
    '',
    tools.length ? '## Tools available' : '',
    toolList,
    '',
    qualityRule,
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
  const generatedPdfs: NonNullable<RunAgentResult['pdfs']> = [];
  let totalCostMicro = 0n;
  let lastProvider: string | undefined;

  // Provider cascade — Groq (best tool calls) → Gemini (great + 1500/day
  // free) → Cohere (text fallback). When one rate-limits, the next picks
  // up; on a fresh rolling-window reset the cooldown clears. See
  // src/llm/fallback.ts for the exact cooldown logic.

  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    const llmResult = await chatCompletionWithFallback({
      messages: history as any,
      tools: tools.length ? tools : undefined,
      max_tokens: 4096,
      // Higher temp + freq penalty = much less robotic repetition on
      // multi-turn WhatsApp threads. Picked these by stress-testing
      // 5+ "boa tarde" pings in a row — at temp 0.3 the agent kept
      // re-greeting; at 0.75+freq_penalty 0.5 it shifted to a follow-
      // up question on the second hit. Stays low enough that tool
      // arguments (CEP, FIPE codes, etc) still parse correctly.
      temperature: 0.75,
      frequency_penalty: 0.5,
      presence_penalty: 0.3,
    });
    lastProvider = llmResult.provider || lastProvider;
    const msg: ChatMessage = (llmResult.message as ChatMessage) ?? {};

    history.push(msg);

    const tcs = msg.tool_calls ?? [];
    if (tcs.length === 0) {
      const content = String(msg.content ?? '');

      // ─── Per-turn LLM debit ────────────────────────────────────
      // Charge the owner's wallet for the conversation itself, not
      // just the tools that fired during it. This is the platform's
      // base cost recovery — without it, a chatty visitor agent that
      // doesn't call tools never depletes the owner's wallet, and
      // the math doesn't close. Skipped on cache hits (handled at
      // the early-return path above).
      const llmTurnCost = getLlmTurnCostMicro();
      if (llmTurnCost > 0n && ownerId && content.length > 0) {
        try {
          const { debit } = await import('~/wallet/service');
          await debit({
            userId: ownerId,
            amountMicro: llmTurnCost,
            type: 'debit',
            meta: {
              purpose: 'agent_turn',
              agent_id: agentId,
              provider: lastProvider,
              iterations: iter + 1,
              tool_calls: toolCallsExecuted.length,
            },
          });
          totalCostMicro += llmTurnCost;
        } catch (err) {
          // Insufficient funds shouldn't block the reply — the customer
          // already got an answer. Log so the operator sees it; the
          // owner will hit balance-low alerts via the wallet flow.
          const { log } = await import('~/lib/logger');
          log.warn('agent.turn_debit.failed', {
            agent_id: agentId,
            owner_id: ownerId,
            cost_micro: llmTurnCost.toString(),
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

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
        const turnCost = totalCostMicro;
        // void = explicit fire-and-forget
        void storeInCache(agentId, lastUser.content, content, turnCost).catch(() => {});
      }

      // Surface the rules version this turn ran on so the operator can match
      // unexpected behavior to a deploy ("oh, that was running on rules-v Y").
      const { currentRulesVersion } = await import('~/agents/knowledge-cache');
      const rulesVersion = await currentRulesVersion();
      return {
        content,
        tool_calls_executed: toolCallsExecuted,
        iterations: iter + 1,
        finish_reason: 'stop',
        total_cost_usdc: (Number(totalCostMicro) / 1_000_000).toFixed(6),
        tools_offered: effectiveTools,
        provider: lastProvider,
        latency_ms: Date.now() - t0,
        rules_version: rulesVersion,
        ...(generatedImages.length ? { images: generatedImages } : {}),
        ...(generatedPixPayments.length ? { pixPayments: generatedPixPayments } : {}),
        ...(generatedPdfs.length ? { pdfs: generatedPdfs } : {}),
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

      // ─── Special-case: schedule_appointment ─────────────────────────
      // Inserts an appointments row. The contact phone / memory_id / name
      // are NOT in tool args (LLM shouldn't have to repeat them) — they
      // come from `c.set('axon:contact_*')` set by the channel handler
      // (whatsapp.ts) before calling runAgent. The daily reminder cron
      // sweeps appointments table independently.
      // ─── Special-case: search_catalog ─────────────────────────────
      // No upstream API call — pulls from the agent's own JSONB
      // catalog field (loaded once at the channel handler). Free
      // and instant; serves as the "real inventory" lookup so the
      // LLM doesn't invent items.
      if (tc.function.name === 'search_catalog') {
        const tcStart = Date.now();
        try {
          const items = (c.get('axon:catalog' as never) as unknown[]) || [];
          const query = String(args.query || '').trim();
          const limit = Math.min(Number(args.limit) || 10, 25);
          if (!Array.isArray(items) || items.length === 0) {
            const result = JSON.stringify({ items: [], note: 'Catálogo vazio. Avise o cliente honestamente que ainda não há inventário cadastrado.' });
            history.push({ role: 'tool', tool_call_id: tc.id, content: result });
            toolCallsExecuted.push({ name: 'search_catalog', args, ok: true, cost_usdc: '0', ms: Date.now() - tcStart, response_excerpt: result.slice(0, 280), status: 200 });
            continue;
          }
          const { searchCatalog } = await import('~/agents/catalog');
          const matches = searchCatalog(items as Parameters<typeof searchCatalog>[0], query, limit);
          const result = JSON.stringify({
            query,
            match_count: matches.length,
            total_in_catalog: items.length,
            items: matches,
          });
          history.push({ role: 'tool', tool_call_id: tc.id, content: result });
          toolCallsExecuted.push({
            name: 'search_catalog', args, ok: true, cost_usdc: '0',
            ms: Date.now() - tcStart, response_excerpt: result.slice(0, 280), status: 200,
          });
        } catch (err: any) {
          const errMsg = err.message || String(err);
          history.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify({ error: errMsg }) });
          toolCallsExecuted.push({ name: 'search_catalog', args, ok: false, cost_usdc: '0', error: errMsg, ms: Date.now() - tcStart });
        }
        continue;
      }

      // ─── Special-case: send_listing_photo ────────────────────────
      // Queues a real photo (URL from catalog) for out-of-band delivery
      // by the channel handler. Caps at 3 photos per turn so the LLM
      // can't spam an entire catalog. URL must be public http(s).
      if (tc.function.name === 'send_listing_photo') {
        const tcStart = Date.now();
        const url = String(args.image_url || '').trim();
        const caption = String(args.caption || '').slice(0, 200);
        const errReply = (msg: string) => {
          history.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify({ ok: false, error: msg }) });
          toolCallsExecuted.push({ name: 'send_listing_photo', args, ok: false, cost_usdc: '0', error: msg, ms: Date.now() - tcStart });
        };
        if (!/^https?:\/\//i.test(url)) {
          errReply('image_url must start with http(s)://. Get the URL from search_catalog first.');
          continue;
        }
        const alreadyQueued = generatedImages.filter((i) => i.url).length;
        if (alreadyQueued >= 3) {
          errReply('Limite de 3 fotos por turno atingido. Pergunte ao cliente se quer ver mais antes de enviar outras.');
          continue;
        }
        // Lazy-extract mime from URL extension; falls back to image/jpeg
        // (most catalog photos are JPEG and Evolution renders fine without
        // exact mime).
        const mimeFromExt = url.match(/\.(png|jpe?g|webp|gif)(?:\?|#|$)/i);
        const mimetype = mimeFromExt
          ? `image/${mimeFromExt[1].toLowerCase().replace('jpg', 'jpeg')}`
          : 'image/jpeg';
        generatedImages.push({ url, mimetype, caption });
        history.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: JSON.stringify({ ok: true, queued: true, note: 'Foto será enviada automaticamente. Continue a conversa normal — NÃO escreva [FOTO] ou *FOTO*; ela já vai pelo canal de mídia.' }),
        });
        toolCallsExecuted.push({
          name: 'send_listing_photo', args, ok: true, cost_usdc: '0',
          ms: Date.now() - tcStart, response_excerpt: `queued ${url.slice(0, 80)}`, status: 200,
        });
        continue;
      }

      if (tc.function.name === 'schedule_appointment') {
        try {
          const phone = c.get('axon:contact_phone' as never) as string | undefined;
          const memoryId = c.get('axon:contact_memory_id' as never) as string | undefined;
          const name = c.get('axon:contact_name' as never) as string | undefined;
          if (!phone || !agentId) {
            const errMsg = 'missing contact context — schedule_appointment can only be called from a channel that sets contact phone';
            history.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify({ error: errMsg }) });
            toolCallsExecuted.push({ name: 'schedule_appointment', args, ok: false, cost_usdc: '0', error: errMsg });
            continue;
          }
          const isoStr = String(args.scheduled_for_iso || '').trim();
          const scheduledFor = new Date(isoStr);
          if (Number.isNaN(scheduledFor.getTime())) {
            throw new Error(`invalid scheduled_for_iso: ${isoStr}`);
          }
          const description = String(args.description || '').trim().slice(0, 200);
          if (!description) throw new Error('description is required');
          const duration = typeof args.duration_minutes === 'number' && args.duration_minutes > 0
            ? Math.min(Math.round(args.duration_minutes), 480) : 30;
          const location = args.location ? String(args.location).slice(0, 200) : null;

          const { db } = await import('~/db');
          const { appointments } = await import('~/db/schema');
          const [inserted] = await db.insert(appointments).values({
            agentId,
            contactMemoryId: memoryId || null,
            contactPhone: phone,
            contactName: name || null,
            scheduledFor,
            durationMinutes: duration,
            description,
            location,
            status: 'confirmed',
          }).returning({ id: appointments.id });

          history.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: JSON.stringify({
              ok: true,
              id: inserted?.id,
              scheduled_for: scheduledFor.toISOString(),
              note: 'Appointment registered. Reminder will fire 1 day before. Confirm to the customer in PT-BR (e.g. "Pronto, te marquei pra [data], qualquer coisa só me chamar 📅").',
            }),
          });
          toolCallsExecuted.push({ name: 'schedule_appointment', args, ok: true, cost_usdc: '0' });
        } catch (err: any) {
          const errMsg = err?.message || String(err);
          history.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify({ error: errMsg }) });
          toolCallsExecuted.push({ name: 'schedule_appointment', args, ok: false, cost_usdc: '0', error: errMsg });
        }
        continue;
      }

      // ─── Special-case: send_catalog_pdf ─────────────────────────────
      // Renders the agent's full catalog as a polished PDF (cover + grid
      // with photos) and stages it for delivery via the same WhatsApp
      // sendMedia(document) path used by generate_pdf. No args — pulls
      // straight from the agent row so the LLM can't hallucinate items.
      if (tc.function.name === 'send_catalog_pdf') {
        const tcStart = Date.now();
        const errReply = (msg: string, code = 0) => {
          history.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify({ ok: false, error: msg }) });
          toolCallsExecuted.push({ name: 'send_catalog_pdf', args, ok: false, cost_usdc: '0', error: msg, ms: Date.now() - tcStart, status: code });
        };
        try {
          if (!agentId) {
            errReply('missing agent context — send_catalog_pdf can only run from a channel with an agent loaded');
            continue;
          }
          const { db: dbMod } = await import('~/db');
          const { agents: agentsTable } = await import('~/db/schema');
          const { eq: eqOp } = await import('drizzle-orm');
          const [agentRow] = await dbMod.select().from(agentsTable).where(eqOp(agentsTable.id, agentId)).limit(1);
          if (!agentRow) {
            errReply('agent not found');
            continue;
          }
          const items = Array.isArray(agentRow.catalog) ? agentRow.catalog as Record<string, unknown>[] : [];
          if (items.length === 0) {
            errReply('catálogo vazio — não há itens para gerar PDF. Avise o cliente em PT-BR que ainda não há produtos cadastrados.');
            continue;
          }
          const businessName = (agentRow.name || 'Catálogo').slice(0, 100);
          const businessContact = (agentRow.businessInfo || '').split('\n')[0]?.slice(0, 200) || '';
          const { renderCatalogPdf, suggestPdfFilename } = await import('~/agents/pdf-renderer');
          const pdfBytes = await renderCatalogPdf({
            businessName,
            businessContact,
            items: items.map((it) => ({
              name: String((it as { name?: unknown }).name || ''),
              price: typeof (it as { price?: unknown }).price === 'number' ? (it as { price: number }).price : null,
              region: typeof (it as { region?: unknown }).region === 'string' ? (it as { region: string }).region : null,
              description: typeof (it as { description?: unknown }).description === 'string' ? (it as { description: string }).description : null,
              image_url: typeof (it as { image_url?: unknown }).image_url === 'string' ? (it as { image_url: string }).image_url : null,
              url: typeof (it as { url?: unknown }).url === 'string' ? (it as { url: string }).url : null,
            })),
          });
          const filename = suggestPdfFilename(`catalogo ${businessName}`);
          generatedPdfs.push({
            base64: pdfBytes.toString('base64'),
            filename,
            title: `Catálogo — ${businessName}`,
            docType: 'outro_gerado',
            excerpt: `${items.length} itens`,
          });
          history.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: JSON.stringify({
              ok: true,
              filename,
              item_count: items.length,
              note: 'Catálogo PDF será entregue automaticamente. Confirme em PT-BR (ex: "Pronto, te mandei o catálogo completo aqui 📄").',
            }),
          });
          toolCallsExecuted.push({ name: 'send_catalog_pdf', args, ok: true, cost_usdc: '0', ms: Date.now() - tcStart, status: 200 });
        } catch (err: any) {
          const errMsg = err?.message || String(err);
          errReply(errMsg);
        }
        continue;
      }

      // ─── Special-case: generate_pdf ─────────────────────────────────
      // Doesn't go through handleCall (no upstream API). Renders a PDF
      // locally via pdfkit and stages it on RunAgentResult.pdfs for the
      // channel handler (WhatsApp webhook) to deliver via sendMedia
      // (mediatype:'document') and persist to contact_documents.
      if (tc.function.name === 'generate_pdf') {
        try {
          const { renderPdf, suggestPdfFilename } = await import('~/agents/pdf-renderer');
          const title = String(args.title || '').trim().slice(0, 200) || 'Documento';
          const body = String(args.body || '').trim().slice(0, 4000) || '';
          const sectionsRaw = Array.isArray(args.sections) ? args.sections : [];
          const sections = sectionsRaw.slice(0, 20).map((s: any) => ({
            heading: String(s?.heading || '').slice(0, 120),
            content: String(s?.content || '').slice(0, 4000),
          })).filter((s: { heading: string; content: string }) => s.heading && s.content);
          const ALLOWED_DOC_TYPES = new Set([
            'comprovante_gerado',
            'agendamento_gerado',
            'ficha_gerada',
            'contrato_gerado',
            'receita_gerada',
            'recibo_gerado',
            'orientacao_gerada',
            'outro_gerado',
          ]);
          const docTypeRaw = String(args.doc_type_hint || '').trim();
          const docType = ALLOWED_DOC_TYPES.has(docTypeRaw) ? docTypeRaw : 'outro_gerado';
          const pdfBytes = await renderPdf({ title, body, sections });
          const filename = suggestPdfFilename(title);
          generatedPdfs.push({
            base64: pdfBytes.toString('base64'),
            filename,
            title,
            docType,
            excerpt: body.slice(0, 500),
          });
          history.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: JSON.stringify({
              ok: true,
              filename,
              title,
              note: 'PDF will be delivered to the customer automatically. Confirm in PT-BR (e.g. "Pronto, te mandei o documento aqui 📄").',
            }),
          });
          toolCallsExecuted.push({ name: 'generate_pdf', args, ok: true, cost_usdc: '0' });
        } catch (err: any) {
          const errMsg = err?.message || String(err);
          history.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: JSON.stringify({ error: errMsg }),
          });
          toolCallsExecuted.push({
            name: 'generate_pdf', args, ok: false, cost_usdc: '0', error: errMsg,
          });
        }
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

      const built: { params?: Record<string, unknown>; body?: unknown } =
        def.buildRequest ? def.buildRequest(args) : { params: args };

      const tcStart = Date.now();
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

        // Response excerpt for the brain panel — first 280 chars of
        // whatever the upstream returned, so the operator can see at
        // a glance "tool was called with X, returned Y" without
        // digging into raw history. Truncated to keep agent_messages
        // meta from bloating.
        const responseExcerpt = String(truncated || '').slice(0, 280);
        toolCallsExecuted.push({
          name: tc.function.name,
          args,
          ok: upstreamRes.ok,
          cost_usdc: cost.toFixed(6),
          ms: Date.now() - tcStart,
          response_excerpt: responseExcerpt,
          status: upstreamRes.status,
        });
        history.push({ role: 'tool', tool_call_id: tc.id, content: truncated });
      } catch (err: any) {
        toolCallsExecuted.push({
          name: tc.function.name,
          args,
          ok: false,
          cost_usdc: '0',
          error: err.message || String(err),
          ms: Date.now() - tcStart,
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
    tools_offered: effectiveTools,
    provider: lastProvider,
    latency_ms: Date.now() - t0,
    ...(generatedImages.length ? { images: generatedImages } : {}),
    ...(generatedPixPayments.length ? { pixPayments: generatedPixPayments } : {}),
    ...(generatedPdfs.length ? { pdfs: generatedPdfs } : {}),
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
    // SSRF guard. The customer's WhatsApp message ultimately drives this
    // URL via the LLM tool call, so the attacker controls input. Without
    // this, asking the agent to "summarize http://169.254.169.254/..."
    // would proxy the IMDS metadata service and hand it back as a chat
    // reply.
    const { checkUrlSafe } = await import('~/lib/ssrf');
    const safe = checkUrlSafe(url);
    if (!safe.ok) {
      return { ok: false, error: `url blocked: ${safe.reason}` };
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
    const { createPixPayment, isMpConfigured } = await import('~/payment/mercadopago');
    // Silent skip when the operator hasn't configured MP. Same pattern as
    // Vision/Voice/Email — feature degrades to a friendly error rather than
    // throwing and breaking the whole agent turn.
    if (!isMpConfigured()) {
      return {
        ok: false,
        error:
          'Pagamento Pix temporariamente indisponível neste agente. Tente outra forma de combinar com o atendente.',
      };
    }
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
