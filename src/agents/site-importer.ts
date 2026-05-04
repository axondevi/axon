/**
 * Catalog import from a website URL.
 *
 * Two-pass strategy:
 *   1. Structured pass — parse JSON-LD blocks (schema.org Product,
 *      RealEstateListing, Vehicle, Offer, ItemList). Real-estate /
 *      e-commerce sites built in the last 5 years almost always emit
 *      this for Google Rich Results, so it's free and exact when present.
 *   2. LLM pass — if structured data yielded < 3 items, send cleaned
 *      visible text to Gemini Flash Lite asking for a JSON array of items.
 *      Catches sites built without schema markup.
 *
 * Cap: 30 items max, single page only (MVP). 10s fetch timeout.
 * No headless browser — sites that render listings purely via JS will
 * fall back to the LLM pass on the bare HTML, which often still works
 * because crawlers expect server-rendered content.
 *
 * Returns CatalogItem[] compatible with the existing parser/pipeline.
 */
import { log } from '~/lib/logger';
import type { CatalogItem } from '~/agents/catalog';

const FETCH_TIMEOUT_MS = 10_000;
const MAX_HTML_BYTES = 800_000; // ~800KB cap to protect Gemini context + memory
const MAX_ITEMS = 30;
const USER_AGENT =
  'Mozilla/5.0 (compatible; AxonCatalogBot/1.0; +https://nexusinovation.com.br)';
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';

export interface ImportResult {
  ok: boolean;
  items: CatalogItem[];
  source: 'jsonld' | 'llm' | 'mixed' | 'none';
  warnings: string[];
  error?: string;
  /** Page title — surfaced so the operator can confirm we got the right site. */
  page_title?: string;
}

function shortHash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36).slice(0, 8);
}

function normalizeUrl(raw: string): string | null {
  let s = raw.trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  try {
    const u = new URL(s);
    if (!/^https?:$/.test(u.protocol)) return null;
    // Block private/local ranges to prevent SSRF. Hostname-level check
    // is good enough as a first line — IP-literal URLs are rare in user
    // input and would still get blocked by Render egress NAT.
    const host = u.hostname.toLowerCase();
    if (
      host === 'localhost' ||
      host === '0.0.0.0' ||
      host.endsWith('.local') ||
      /^127\./.test(host) ||
      /^10\./.test(host) ||
      /^192\.168\./.test(host) ||
      /^169\.254\./.test(host) ||
      /^172\.(1[6-9]|2\d|3[0-1])\./.test(host)
    ) {
      return null;
    }
    return u.toString();
  } catch {
    return null;
  }
}

function priceFromAny(v: unknown): number | undefined {
  if (typeof v === 'number') return isFinite(v) ? v : undefined;
  if (typeof v !== 'string') return undefined;
  const cleaned = v
    .replace(/r\$|reais|brl|usd|\$/gi, '')
    .replace(/\s/g, '')
    .replace(/\.(?=\d{3}(?:\D|$))/g, '')
    .replace(',', '.');
  const n = Number(cleaned);
  return isFinite(n) ? n : undefined;
}

function strFromAny(v: unknown, max = 400): string | undefined {
  if (v === null || v === undefined) return undefined;
  const s = String(v).trim();
  return s ? s.slice(0, max) : undefined;
}

/**
 * Walk an arbitrary JSON-LD value tree and yield each "thing" object.
 * Handles @graph arrays + ItemList itemListElement nesting, which is
 * how most CMSs expose lists.
 */
function* walkJsonLd(node: unknown): Generator<Record<string, unknown>> {
  if (!node) return;
  if (Array.isArray(node)) {
    for (const v of node) yield* walkJsonLd(v);
    return;
  }
  if (typeof node !== 'object') return;
  const obj = node as Record<string, unknown>;
  // Type can be string or array (e.g., ["Product","Vehicle"])
  const t = obj['@type'];
  const types = Array.isArray(t) ? t : t ? [t] : [];
  if (types.length) yield obj;
  // Recurse into common container fields
  for (const k of ['@graph', 'itemListElement', 'mainEntity', 'hasPart']) {
    if (k in obj) yield* walkJsonLd(obj[k]);
  }
  // ItemListElement entries often wrap the actual thing under .item
  if (obj.item) yield* walkJsonLd(obj.item);
}

const ITEM_TYPES = new Set([
  'Product',
  'Offer',
  'IndividualProduct',
  'SomeProducts',
  'RealEstateListing',
  'Apartment',
  'House',
  'SingleFamilyResidence',
  'Residence',
  'Place',
  'Vehicle',
  'Car',
  'Motorcycle',
  'BoatTrip',
  'Service',
  'TouristAttraction',
  'LodgingBusiness',
]);

function jsonLdToItem(
  raw: Record<string, unknown>,
  baseUrl: string,
): CatalogItem | null {
  const t = raw['@type'];
  const types = Array.isArray(t) ? t : t ? [t] : [];
  const isItem = types.some((x) => ITEM_TYPES.has(String(x)));
  if (!isItem) return null;

  const name =
    strFromAny(raw.name) ||
    strFromAny((raw as { headline?: unknown }).headline);
  if (!name) return null;

  // Price can live in offers.price, offers[0].price, or directly on the node
  let price: number | undefined;
  const offers = raw.offers;
  if (offers) {
    const arr = Array.isArray(offers) ? offers : [offers];
    for (const off of arr) {
      if (off && typeof off === 'object') {
        const p = priceFromAny((off as Record<string, unknown>).price);
        if (p !== undefined) {
          price = p;
          break;
        }
      }
    }
  }
  if (price === undefined) price = priceFromAny(raw.price);

  // Region: prefer explicit address.addressLocality, fall back to
  // areaServed or address as a string.
  let region: string | undefined;
  const addr = raw.address;
  if (addr && typeof addr === 'object') {
    const a = addr as Record<string, unknown>;
    region =
      strFromAny(a.addressLocality) ||
      strFromAny(a.addressRegion) ||
      strFromAny(a.streetAddress);
  } else if (typeof addr === 'string') {
    region = strFromAny(addr);
  }
  if (!region) region = strFromAny(raw.areaServed);

  const description =
    strFromAny(raw.description) ||
    strFromAny((raw as { abstract?: unknown }).abstract);

  // Image: can be string, array, or ImageObject {url}
  let image_url: string | undefined;
  const img = raw.image;
  if (typeof img === 'string') image_url = img;
  else if (Array.isArray(img) && img.length) {
    const first = img[0];
    image_url =
      typeof first === 'string'
        ? first
        : strFromAny((first as Record<string, unknown>)?.url);
  } else if (img && typeof img === 'object') {
    image_url = strFromAny((img as Record<string, unknown>).url);
  }
  if (image_url && !/^https?:\/\//i.test(image_url)) {
    try {
      image_url = new URL(image_url, baseUrl).toString();
    } catch {
      image_url = undefined;
    }
  }

  const item: CatalogItem = {
    id: strFromAny(raw.sku) || strFromAny(raw['@id']) || shortHash(name),
    name,
  };
  if (price !== undefined) item.price = price;
  if (region) item.region = region;
  if (description) item.description = description;
  if (image_url) item.image_url = image_url;
  return item;
}

function extractJsonLd(html: string, baseUrl: string): CatalogItem[] {
  const items: CatalogItem[] = [];
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    let json: unknown;
    try {
      // Some sites embed multiple JSON objects separated by commas — wrap
      // in array if the literal opens with { and contains }, { (rare).
      json = JSON.parse(m[1].trim());
    } catch {
      continue;
    }
    for (const obj of walkJsonLd(json)) {
      const item = jsonLdToItem(obj, baseUrl);
      if (item) {
        const key = item.name.toLowerCase() + '|' + (item.price ?? '');
        if (!seen.has(key)) {
          seen.add(key);
          items.push(item);
          if (items.length >= MAX_ITEMS) return items;
        }
      }
    }
  }
  return items;
}

function extractTitle(html: string): string | undefined {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? m[1].replace(/\s+/g, ' ').trim().slice(0, 200) : undefined;
}

/**
 * Strip scripts/styles/comments/svg, collapse whitespace, drop nav/footer
 * heuristically. We want what a customer would actually read on the page:
 * product/listing names, prices, brief descriptions. Keeps under ~12k chars
 * for cheap Gemini calls.
 */
function htmlToVisibleText(html: string): string {
  let s = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
  // Preserve href on anchors briefly so the LLM can reference image links
  // — but really keep the text payload small.
  s = s.replace(/<[^>]+>/g, ' ');
  s = s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
  return s.slice(0, 12_000);
}

async function llmExtract(
  visibleText: string,
  pageUrl: string,
  pageTitle?: string,
): Promise<{ items: CatalogItem[]; warnings: string[] }> {
  const apiKey = process.env.GEMINI_API_KEY;
  const warnings: string[] = [];
  if (!apiKey) {
    return { items: [], warnings: ['GEMINI_API_KEY ausente — fallback indisponível'] };
  }
  // Flash Lite has a separate quota from regular Flash (per memory note)
  // and is cheap enough to burn on a one-off catalog import.
  const model = process.env.GEMINI_EXTRACT_MODEL || 'gemini-2.5-flash-lite';

  const prompt = [
    'Você é um extrator de catálogo. Recebe o texto de UMA página de um site (imobiliária, loja, concessionária, restaurante, etc) e retorna os itens (imóveis, produtos, carros, pratos, serviços) listados ali.',
    `Página: ${pageTitle || '(sem título)'} — ${pageUrl}`,
    '',
    'Regras:',
    '- Retorne APENAS um JSON array, sem markdown, sem explicação.',
    '- Cada item tem: name (obrigatório), price (número em BRL ou null), region (string ou null), description (string curta, max 200 chars, ou null), image_url (string ou null).',
    '- Se a página NÃO listar itens (ex: é um blog, contato, sobre), retorne [].',
    '- Máximo 30 itens. Se houver mais, pegue os 30 primeiros.',
    '- price: extraia o valor numérico. "R$ 1.234,56" → 1234.56. "1.500/mês" → 1500. Sem moeda no JSON.',
    '- Não invente. Se um campo não está claro, use null.',
    '',
    'Texto da página:',
    '"""',
    visibleText,
    '"""',
  ].join('\n');

  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 4096,
      responseMimeType: 'application/json',
    },
  };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30_000);
  try {
    const res = await fetch(
      `${GEMINI_BASE}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      },
    );
    if (!res.ok) {
      const t = await res.text();
      warnings.push(`Gemini ${res.status}: ${t.slice(0, 160)}`);
      return { items: [], warnings };
    }
    const data = (await res.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      // Sometimes the model wraps the JSON in ```json fences despite the
      // mime hint. Best-effort recovery.
      const m = text.match(/\[[\s\S]*\]/);
      if (m) {
        try {
          parsed = JSON.parse(m[0]);
        } catch {
          warnings.push('Gemini retornou JSON inválido');
          return { items: [], warnings };
        }
      } else {
        warnings.push('Gemini retornou texto sem JSON');
        return { items: [], warnings };
      }
    }
    if (!Array.isArray(parsed)) {
      warnings.push('Gemini retornou objeto, esperava array');
      return { items: [], warnings };
    }
    const items: CatalogItem[] = [];
    for (let i = 0; i < parsed.length && items.length < MAX_ITEMS; i++) {
      const r = parsed[i] as Record<string, unknown>;
      if (!r || typeof r !== 'object') continue;
      const name = strFromAny(r.name);
      if (!name) continue;
      const item: CatalogItem = {
        id: shortHash(name + ':' + i),
        name,
      };
      const price = priceFromAny(r.price);
      if (price !== undefined) item.price = price;
      const region = strFromAny(r.region);
      if (region) item.region = region;
      const description = strFromAny(r.description);
      if (description) item.description = description;
      let image = strFromAny(r.image_url);
      if (image && !/^https?:\/\//i.test(image)) {
        try {
          image = new URL(image, pageUrl).toString();
        } catch {
          image = undefined;
        }
      }
      if (image) item.image_url = image;
      items.push(item);
    }
    return { items, warnings };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    warnings.push(`Falha Gemini: ${msg}`);
    return { items: [], warnings };
  } finally {
    clearTimeout(timer);
  }
}

export async function importCatalogFromUrl(rawUrl: string): Promise<ImportResult> {
  const url = normalizeUrl(rawUrl);
  if (!url) {
    return {
      ok: false,
      items: [],
      source: 'none',
      warnings: [],
      error: 'URL inválida ou bloqueada (sem http/https, ou IP privado).',
    };
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  let html = '';
  let pageTitle: string | undefined;
  try {
    const res = await fetch(url, {
      headers: {
        'user-agent': USER_AGENT,
        accept: 'text/html,application/xhtml+xml',
        'accept-language': 'pt-BR,pt;q=0.9,en;q=0.5',
      },
      signal: ctrl.signal,
      redirect: 'follow',
    });
    if (!res.ok) {
      return {
        ok: false,
        items: [],
        source: 'none',
        warnings: [],
        error: `Site respondeu HTTP ${res.status}. Pode estar bloqueando bots ou indisponível.`,
      };
    }
    const ctype = res.headers.get('content-type') || '';
    if (!/html|xml/i.test(ctype)) {
      return {
        ok: false,
        items: [],
        source: 'none',
        warnings: [],
        error: `Conteúdo não é HTML (${ctype}). Cole a URL de uma página com a lista de itens.`,
      };
    }
    // Read at most MAX_HTML_BYTES so a 50MB page doesn't OOM the worker.
    const reader = res.body?.getReader();
    if (!reader) {
      html = await res.text();
    } else {
      const chunks: Uint8Array[] = [];
      let total = 0;
      while (total < MAX_HTML_BYTES) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        total += value.byteLength;
      }
      try {
        await reader.cancel();
      } catch {
        /* ignore */
      }
      const buf = new Uint8Array(Math.min(total, MAX_HTML_BYTES));
      let off = 0;
      for (const ch of chunks) {
        const take = Math.min(ch.byteLength, buf.length - off);
        buf.set(ch.subarray(0, take), off);
        off += take;
        if (off >= buf.length) break;
      }
      html = new TextDecoder('utf-8', { fatal: false }).decode(buf);
    }
    pageTitle = extractTitle(html);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const hint = msg.includes('aborted')
      ? 'Tempo esgotado (10s). O site pode estar lento ou bloqueando bots.'
      : msg.includes('ENOTFOUND') || msg.includes('getaddrinfo')
        ? 'Domínio não encontrado. Confira a URL.'
        : `Falha ao acessar o site: ${msg.slice(0, 120)}`;
    return { ok: false, items: [], source: 'none', warnings: [], error: hint };
  } finally {
    clearTimeout(timer);
  }

  const warnings: string[] = [];

  // Pass 1: structured data
  const jsonldItems = extractJsonLd(html, url);
  if (jsonldItems.length >= 3) {
    log.info('site-importer.jsonld_hit', { url, items: jsonldItems.length });
    return {
      ok: true,
      items: jsonldItems.slice(0, MAX_ITEMS),
      source: 'jsonld',
      warnings,
      page_title: pageTitle,
    };
  }

  // Pass 2: LLM on visible text
  const visibleText = htmlToVisibleText(html);
  if (visibleText.length < 200) {
    return {
      ok: false,
      items: jsonldItems,
      source: jsonldItems.length ? 'jsonld' : 'none',
      warnings,
      error:
        'Página muito vazia — provavelmente carrega via JavaScript que o importador não executa. Tente uma URL específica de listagem.',
      page_title: pageTitle,
    };
  }
  const llm = await llmExtract(visibleText, url, pageTitle);
  warnings.push(...llm.warnings);

  // Merge: JSON-LD items first (more reliable), then LLM dedupe by name
  const seenNames = new Set(jsonldItems.map((i) => i.name.toLowerCase()));
  const merged = [...jsonldItems];
  for (const it of llm.items) {
    if (merged.length >= MAX_ITEMS) break;
    const k = it.name.toLowerCase();
    if (!seenNames.has(k)) {
      seenNames.add(k);
      merged.push(it);
    }
  }

  if (merged.length === 0) {
    return {
      ok: false,
      items: [],
      source: 'none',
      warnings,
      error:
        'Não consegui extrair itens. Tente colar a URL da página de listagem (ex: /imoveis, /carros, /produtos) em vez da home.',
      page_title: pageTitle,
    };
  }

  log.info('site-importer.success', {
    url,
    jsonld: jsonldItems.length,
    llm: llm.items.length,
    final: merged.length,
  });
  return {
    ok: true,
    items: merged,
    source: jsonldItems.length && llm.items.length ? 'mixed' : jsonldItems.length ? 'jsonld' : 'llm',
    warnings,
    page_title: pageTitle,
  };
}
