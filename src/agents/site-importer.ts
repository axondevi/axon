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

export interface BusinessInfo {
  name?: string;
  description?: string;
  phone?: string;
  whatsapp?: string;
  email?: string;
  address?: string;
  hours?: string;
  website?: string;
  social?: string[];
  areas?: string[];
}

export interface ImportResult {
  ok: boolean;
  items: CatalogItem[];
  source: 'jsonld' | 'llm' | 'mixed' | 'none';
  warnings: string[];
  error?: string;
  /** Page title — surfaced so the operator can confirm we got the right site. */
  page_title?: string;
  /** Structured business profile (for UI preview). */
  business?: BusinessInfo;
  /** PT-BR formatted text block, ready to drop into agents.business_info. */
  business_info_text?: string;
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

// schema.org types that represent the business itself (not a listing).
// RealEstateAgent + AutomotiveBusiness are the most common for our
// target verticals; LocalBusiness is the broad fallback.
const BUSINESS_TYPES = new Set([
  'Organization',
  'LocalBusiness',
  'Corporation',
  'RealEstateAgent',
  'AutomotiveBusiness',
  'AutoDealer',
  'AutoRepair',
  'Store',
  'Restaurant',
  'FoodEstablishment',
  'MedicalBusiness',
  'MedicalOrganization',
  'Dentist',
  'BeautySalon',
  'HairSalon',
  'HealthAndBeautyBusiness',
  'ProfessionalService',
  'LegalService',
  'FinancialService',
  'TravelAgency',
  'LodgingBusiness',
  'EducationalOrganization',
  'School',
]);

function addressFromAny(addr: unknown): string | undefined {
  if (!addr) return undefined;
  if (typeof addr === 'string') return strFromAny(addr);
  if (typeof addr !== 'object') return undefined;
  const a = addr as Record<string, unknown>;
  const parts = [
    strFromAny(a.streetAddress),
    strFromAny(a.addressLocality),
    strFromAny(a.addressRegion),
    strFromAny(a.postalCode),
  ].filter(Boolean);
  return parts.length ? parts.join(', ') : undefined;
}

function hoursFromAny(raw: unknown): string | undefined {
  // openingHours can be: string, string[], or array of OpeningHoursSpecification objects.
  if (!raw) return undefined;
  if (typeof raw === 'string') return strFromAny(raw);
  if (Array.isArray(raw)) {
    const lines = raw
      .map((v) => {
        if (typeof v === 'string') return v.trim();
        if (v && typeof v === 'object') {
          const o = v as Record<string, unknown>;
          const days = Array.isArray(o.dayOfWeek)
            ? o.dayOfWeek.map(String).map((d) => d.split('/').pop()).join(', ')
            : strFromAny(o.dayOfWeek)?.split('/').pop();
          const open = strFromAny(o.opens);
          const close = strFromAny(o.closes);
          if (days && open && close) return `${days}: ${open}–${close}`;
        }
        return '';
      })
      .filter(Boolean);
    return lines.length ? lines.join(' · ').slice(0, 300) : undefined;
  }
  return undefined;
}

function jsonLdToBusiness(raw: Record<string, unknown>): BusinessInfo | null {
  const t = raw['@type'];
  const types = Array.isArray(t) ? t : t ? [t] : [];
  if (!types.some((x) => BUSINESS_TYPES.has(String(x)))) return null;

  const info: BusinessInfo = {};
  const name = strFromAny(raw.name) || strFromAny((raw as { legalName?: unknown }).legalName);
  if (name) info.name = name;

  const description = strFromAny(raw.description, 800);
  if (description) info.description = description;

  const phone = strFromAny(raw.telephone) || strFromAny((raw as { phone?: unknown }).phone);
  if (phone) info.phone = phone;

  const email = strFromAny(raw.email);
  if (email) info.email = email;

  const address = addressFromAny(raw.address);
  if (address) info.address = address;

  const hours = hoursFromAny(raw.openingHours) || hoursFromAny((raw as { openingHoursSpecification?: unknown }).openingHoursSpecification);
  if (hours) info.hours = hours;

  const website = strFromAny(raw.url);
  if (website) info.website = website;

  // areaServed: string | array | Place {name}
  const areaRaw = raw.areaServed;
  const areas: string[] = [];
  const pushArea = (v: unknown) => {
    if (typeof v === 'string') {
      const s = v.trim();
      if (s) areas.push(s);
    } else if (v && typeof v === 'object') {
      const n = strFromAny((v as Record<string, unknown>).name);
      if (n) areas.push(n);
    }
  };
  if (Array.isArray(areaRaw)) areaRaw.forEach(pushArea);
  else if (areaRaw) pushArea(areaRaw);
  if (areas.length) info.areas = areas.slice(0, 8);

  // sameAs is the schema.org convention for social profiles
  const sameAs = (raw as { sameAs?: unknown }).sameAs;
  if (Array.isArray(sameAs)) {
    const social = sameAs
      .map((s) => strFromAny(s))
      .filter((s): s is string => !!s && /^https?:\/\//i.test(s))
      .slice(0, 6);
    if (social.length) info.social = social;
  } else if (typeof sameAs === 'string' && /^https?:\/\//i.test(sameAs)) {
    info.social = [sameAs];
  }

  return Object.keys(info).length ? info : null;
}

/** Merge — keep first non-empty value for each field. */
function mergeBusiness(into: BusinessInfo, from: BusinessInfo): BusinessInfo {
  const out: BusinessInfo = { ...into };
  for (const k of Object.keys(from) as (keyof BusinessInfo)[]) {
    if (out[k] === undefined || (Array.isArray(out[k]) && (out[k] as unknown[]).length === 0)) {
      // @ts-expect-error widened union write
      out[k] = from[k];
    }
  }
  return out;
}

function extractMetaBusiness(html: string, baseUrl: string): BusinessInfo {
  // Backup pass: og:* and standard <meta> tags. Useful when the site
  // has no JSON-LD Organization block but ships basic OpenGraph for
  // social previews — virtually every modern site does.
  const info: BusinessInfo = {};
  const meta = (key: string): string | undefined => {
    const re = new RegExp(
      `<meta[^>]+(?:property|name)=["']${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["'][^>]*content=["']([^"']+)["']`,
      'i',
    );
    const m = html.match(re);
    if (m) return m[1].trim();
    // Reverse attribute order
    const re2 = new RegExp(
      `<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["']${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']`,
      'i',
    );
    const m2 = html.match(re2);
    return m2 ? m2[1].trim() : undefined;
  };
  const name = meta('og:site_name') || meta('application-name');
  if (name) info.name = name;
  const description = meta('og:description') || meta('description');
  if (description) info.description = description.slice(0, 800);
  // og: doesn't standardize phone but some sites use business:contact_data:phone_number
  const phone = meta('business:contact_data:phone_number') || meta('og:phone_number');
  if (phone) info.phone = phone;
  const email = meta('business:contact_data:email');
  if (email) info.email = email;
  // Compose address from business:contact_data:* if present
  const street = meta('business:contact_data:street_address');
  const city = meta('business:contact_data:locality');
  const region = meta('business:contact_data:region');
  const addrParts = [street, city, region].filter(Boolean);
  if (addrParts.length) info.address = addrParts.join(', ');
  // og:url as canonical website
  const url = meta('og:url');
  if (url) {
    try {
      info.website = new URL(url, baseUrl).toString();
    } catch {
      /* ignore */
    }
  }
  return info;
}

const SOCIAL_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /(?:wa\.me|api\.whatsapp\.com\/send|whatsapp\.com\/[+\d])[^"'\s<>]*/gi, label: 'whatsapp' },
  { re: /https?:\/\/(?:www\.)?instagram\.com\/[^"'\s<>?#]+/gi, label: 'instagram' },
  { re: /https?:\/\/(?:www\.)?facebook\.com\/[^"'\s<>?#]+/gi, label: 'facebook' },
];

function extractContactsFromHtml(html: string, info: BusinessInfo): BusinessInfo {
  // Phone fallback: scan first 30k of HTML for BR phone patterns. Conservative
  // regex — only matches with explicit (DDD) or +55 prefixes to avoid grabbing
  // arbitrary numbers like prices or zipcodes.
  const out: BusinessInfo = { ...info };
  const head = html.slice(0, 30_000);
  if (!out.phone) {
    const m = head.match(/(?:\+?55\s?)?\(?\d{2}\)?\s?9?\s?\d{4}[-\s]?\d{4}/);
    if (m) out.phone = m[0].trim();
  }
  if (!out.email) {
    // Prefer mailto: links — they're explicit. Skip generic noreply addresses.
    const m = head.match(/mailto:([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/);
    if (m && !/no[-_]?reply/i.test(m[1])) out.email = m[1];
  }
  // Social: dedup by host+path
  if (!out.social || out.social.length === 0) {
    const found = new Set<string>();
    for (const { re } of SOCIAL_PATTERNS) {
      let mm: RegExpExecArray | null;
      const localRe = new RegExp(re.source, re.flags);
      while ((mm = localRe.exec(html)) !== null && found.size < 6) {
        const url = mm[0].replace(/['"<>]+$/, '');
        // Strip common share URLs (intent, tracker)
        if (/sharer|intent\/tweet|share=true/i.test(url)) continue;
        found.add(url);
      }
    }
    // wa.me numbers — promote to dedicated whatsapp field
    for (const url of found) {
      if (/wa\.me|api\.whatsapp/i.test(url) && !out.whatsapp) {
        out.whatsapp = url;
      }
    }
    const social = [...found].filter((u) => !/wa\.me|api\.whatsapp/i.test(u));
    if (social.length) out.social = social;
  }
  return out;
}

export function formatBusinessInfo(info: BusinessInfo, fallbackTitle?: string): string {
  // Compose a PT-BR text block that fits agents.businessInfo. Order
  // mirrors how a customer-facing rep would introduce the business.
  const lines: string[] = [];
  const name = info.name || fallbackTitle;
  if (name) lines.push(`Nome: ${name}`);
  if (info.description) lines.push(`Sobre: ${info.description}`);
  if (info.address) lines.push(`Endereço: ${info.address}`);
  if (info.areas && info.areas.length) lines.push(`Atende: ${info.areas.join(', ')}`);
  if (info.hours) lines.push(`Horário: ${info.hours}`);
  if (info.phone) lines.push(`Telefone: ${info.phone}`);
  if (info.whatsapp) lines.push(`WhatsApp: ${info.whatsapp}`);
  if (info.email) lines.push(`E-mail: ${info.email}`);
  if (info.website) lines.push(`Site: ${info.website}`);
  if (info.social && info.social.length) lines.push(`Redes: ${info.social.join(' · ')}`);
  return lines.join('\n').slice(0, 4000);
}

function extractFromJsonLd(html: string, baseUrl: string): {
  items: CatalogItem[];
  business: BusinessInfo;
} {
  const items: CatalogItem[] = [];
  const seen = new Set<string>();
  let business: BusinessInfo = {};
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    let json: unknown;
    try {
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
          if (items.length >= MAX_ITEMS) break;
        }
        continue;
      }
      const biz = jsonLdToBusiness(obj);
      if (biz) business = mergeBusiness(business, biz);
    }
    if (items.length >= MAX_ITEMS) break;
  }
  return { items, business };
}

function extractTitle(html: string): string | undefined {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? m[1].replace(/\s+/g, ' ').trim().slice(0, 200) : undefined;
}

/**
 * Best-effort business name from a raw page title. Strips common SEO
 * suffixes ("| Site Name", " - Categoria") and prefers the segment
 * with a known business word ("Imobiliária", "Loja", etc) when
 * present. Falls back to the first segment.
 */
function nameFromTitle(title: string | undefined): string | undefined {
  if (!title) return undefined;
  const cleaned = title.replace(/\s+/g, ' ').trim();
  // Split on common separators used by CMS title templates.
  const segments = cleaned.split(/\s+[|·–—:>]\s+|\s+-\s+/g).map((s) => s.trim()).filter(Boolean);
  if (segments.length === 0) return undefined;
  const BUSINESS_WORDS =
    /\b(imobiliária|imobiliaria|imóveis|imoveis|loja|store|concessionária|concessionaria|auto|veículos|veiculos|carros|restaurante|clínica|clinica|consultório|consultorio|salão|salao|estética|estetica|advocacia|escritório|escritorio|empresa|hotel|pousada|pizzaria|padaria|farmácia|farmacia|petshop|pet shop|academia|escola|colégio|colegio)\b/i;
  // Prefer the segment that mentions a business word — usually it's the
  // brand part, not the page topic.
  const branded = segments.find((s) => BUSINESS_WORDS.test(s));
  let pick = branded || segments[0];
  // Strip leading "Bem-vindo a", "Página inicial -", noise prefixes.
  pick = pick.replace(/^(bem[-\s]?vindo[s]?\s+a[oà]?\s+|home\s*[-:]\s*|página\s+inicial\s*[-:]\s*)/i, '').trim();
  // 60 chars is a sane brand length; longer = probably a sentence.
  return pick.length > 60 ? undefined : pick;
}

/**
 * Strip scripts/styles/comments/svg, collapse whitespace, drop nav/footer
 * heuristically. We want what a customer would actually read on the page:
 * product/listing names, prices, brief descriptions. Keeps under ~12k chars
 * for cheap Gemini calls.
 */
/** Decide if an `<img src>` is a real listing photo vs UI chrome
 *  (logos, sprite icons, base64 placeholders, tracking pixels). The
 *  LLM gets confused by hundreds of tiny URLs, so we filter aggressively
 *  before injecting into the prompt. */
function isListingImageUrl(url: string): boolean {
  if (!url) return false;
  const lower = url.toLowerCase();
  if (lower.startsWith('data:')) return false;
  if (!/^https?:\/\//i.test(url)) return false;
  // Common chrome / non-photo patterns
  if (/(logo|sprite|icon|favicon|whatsapp|instagram|facebook|youtube|tiktok|placeholder|loading|spinner|tracking|pixel\.gif)/i.test(lower)) {
    return false;
  }
  // Path under common asset folders that don't host listing photos
  if (/\/(icons?|svg|sprites?|tracking|analytics)\//i.test(lower)) return false;
  // Allowed extensions — skip GIF (usually animations / loaders)
  if (!/\.(jpe?g|png|webp)(?:\?|#|$)/i.test(lower)) return false;
  return true;
}

function htmlToVisibleText(html: string): string {
  let s = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
  // Preserve <img src> as inline markers so the LLM can correlate
  // photos with the listing they sit next to in the DOM. We try the
  // common attributes that lazy-loaders use (data-src, data-lazy)
  // before src, since modern sites set src= to a placeholder. Cap at
  // 60 markers so we don't blow the prompt budget on icon-heavy pages.
  let imgCount = 0;
  s = s.replace(
    /<img\b[^>]*?(?:data-src|data-lazy(?:-src)?|data-original|src)=["']([^"']+)["'][^>]*>/gi,
    (_full, src: string) => {
      if (imgCount >= 60) return ' ';
      // Resolve relative URLs would need baseUrl; we accept absolute only
      // here and let the LLM include them verbatim. Relative ones get
      // dropped — the post-LLM normalizer in llmExtract resolves with
      // pageUrl just like JSON-LD images.
      if (!isListingImageUrl(src)) return ' ';
      imgCount++;
      return ` [IMG: ${src}] `;
    },
  );
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
  return s.slice(0, 14_000);
}

/**
 * Try Gemini with model fallback (429/503 → next model). Returns
 * undefined when no key configured. Only retries on quota/overload
 * errors; other 4xx is request-level and would fail again.
 */
async function tryGemini(
  prompt: string,
  maxOutputTokens: number,
  timeoutMs: number,
): Promise<{ ok: true; text: string } | { ok: false; error: string } | undefined> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return undefined;
  const primary = process.env.GEMINI_EXTRACT_MODEL || 'gemini-2.5-flash-lite';
  const chain = Array.from(new Set([primary, 'gemini-2.5-flash-lite', 'gemini-2.5-flash']));
  const body = JSON.stringify({
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.1, maxOutputTokens, responseMimeType: 'application/json' },
  });
  let lastErr = '';
  for (const model of chain) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(
        `${GEMINI_BASE}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
        { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: ctrl.signal },
      );
      if (res.ok) {
        const data = (await res.json()) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
        return { ok: true, text };
      }
      lastErr = `gemini/${model} → ${res.status}: ${(await res.text()).slice(0, 160)}`;
      if (res.status !== 429 && res.status !== 503) return { ok: false, error: lastErr };
    } catch (err) {
      lastErr = `gemini/${model} → ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      clearTimeout(timer);
    }
  }
  return { ok: false, error: lastErr || 'all gemini models failed' };
}

/**
 * Try Groq (super-fast Llama/Qwen serverless). OpenAI-compatible.
 * Tried right after Gemini because it's the fastest free-tier option
 * (~2s for 14k char prompts). Free tier is generous (~14k req/day).
 */
async function tryGroq(
  prompt: string,
  maxOutputTokens: number,
  timeoutMs: number,
): Promise<{ ok: true; text: string } | { ok: false; error: string } | undefined> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return undefined;
  // 70b is the only model on Groq's free tier with 32k context (others
  // are 8k = our 14k-char prompt blows the limit). TPM cap is 6k/min so
  // sequential deep-crawl calls will throttle — that's why this is the
  // 2nd fallback (Gemini primary handles bulk; Groq backstops when
  // Gemini quota exhausted).
  const model = process.env.GROQ_EXTRACT_MODEL || 'llama-3.3-70b-versatile';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: 'You are a precise JSON extractor. Always respond with valid JSON only.' },
          { role: 'user', content: prompt },
        ],
        temperature: 0.1,
        max_tokens: maxOutputTokens,
        response_format: { type: 'json_object' },
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      return { ok: false, error: `groq/${model} → ${res.status}: ${(await res.text()).slice(0, 160)}` };
    }
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const text = data.choices?.[0]?.message?.content || '';
    return { ok: true, text };
  } catch (err) {
    return { ok: false, error: `groq/${model} → ${err instanceof Error ? err.message : String(err)}` };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Try SiliconFlow (Qwen/DeepSeek aggregator). OpenAI-compatible API.
 * Used as cross-vendor fallback when Gemini quota is exhausted —
 * separate provider, separate quota, separate models. JSON mode via
 * `response_format: { type: 'json_object' }` (Qwen3 supports this).
 */
async function trySiliconFlow(
  prompt: string,
  maxOutputTokens: number,
  timeoutMs: number,
): Promise<{ ok: true; text: string } | { ok: false; error: string } | undefined> {
  const apiKey = process.env.SILICONFLOW_API_KEY;
  if (!apiKey) return undefined;
  // Qwen 2.5 7B is fast + cheap and handles JSON well; bigger models
  // give marginal accuracy gains for structured extraction. Override via
  // SILICONFLOW_EXTRACT_MODEL (e.g. Qwen/Qwen2.5-72B-Instruct,
  // deepseek-ai/DeepSeek-V2.5, Qwen/Qwen3-30B-A3B).
  const model = process.env.SILICONFLOW_EXTRACT_MODEL || 'Qwen/Qwen2.5-7B-Instruct';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch('https://api.siliconflow.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: 'You are a precise JSON extractor. Always respond with valid JSON only.' },
          { role: 'user', content: prompt },
        ],
        temperature: 0.1,
        max_tokens: maxOutputTokens,
        response_format: { type: 'json_object' },
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      return { ok: false, error: `siliconflow/${model} → ${res.status}: ${(await res.text()).slice(0, 160)}` };
    }
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const text = data.choices?.[0]?.message?.content || '';
    return { ok: true, text };
  } catch (err) {
    return { ok: false, error: `siliconflow/${model} → ${err instanceof Error ? err.message : String(err)}` };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Cross-vendor JSON extraction with provider fallback. Tries Gemini
 * first (cheapest + JSON-mode tuned), then SiliconFlow (Qwen/DeepSeek)
 * when Gemini's full chain is exhausted. Either provider can be
 * disabled by omitting its API key. Returns the first successful text
 * blob — caller still needs to JSON.parse it.
 */
async function callExtractionJson(
  prompt: string,
  maxOutputTokens: number,
  timeoutMs: number,
): Promise<{ ok: true; text: string; provider: string } | { ok: false; error: string }> {
  const errors: string[] = [];
  // Order: Gemini (cheapest+JSON-tuned) → Groq (fastest backup) → SF
  // (slowest but huge model variety). Stops at first success.
  const gem = await tryGemini(prompt, maxOutputTokens, timeoutMs);
  if (gem?.ok) return { ok: true, text: gem.text, provider: 'gemini' };
  if (gem) errors.push(gem.error);
  const gq = await tryGroq(prompt, maxOutputTokens, timeoutMs);
  if (gq?.ok) return { ok: true, text: gq.text, provider: 'groq' };
  if (gq) errors.push(gq.error);
  const sf = await trySiliconFlow(prompt, maxOutputTokens, timeoutMs);
  if (sf?.ok) return { ok: true, text: sf.text, provider: 'siliconflow' };
  if (sf) errors.push(sf.error);
  return {
    ok: false,
    error: errors.length ? errors.join(' | ') : 'no extraction provider configured (set GEMINI_API_KEY, GROQ_API_KEY, or SILICONFLOW_API_KEY)',
  };
}

async function llmExtract(
  visibleText: string,
  pageUrl: string,
  pageTitle?: string,
): Promise<{ items: CatalogItem[]; warnings: string[] }> {
  const warnings: string[] = [];
  if (!process.env.GEMINI_API_KEY && !process.env.GROQ_API_KEY && !process.env.SILICONFLOW_API_KEY) {
    return { items: [], warnings: ['Nenhum extractor configurado — set GEMINI_API_KEY, GROQ_API_KEY ou SILICONFLOW_API_KEY'] };
  }

  // SiliconFlow expects a JSON object (not array) at top level when
  // response_format=json_object is set, so wrap the array in an `items`
  // key. The post-extract code already handles {items: [...]} shape via
  // the recovery branch.
  const prompt = [
    'Você é um extrator de catálogo. Recebe o texto de UMA página de um site (imobiliária, loja, concessionária, restaurante, etc) e retorna os itens (imóveis, produtos, carros, pratos, serviços) listados ali.',
    `Página: ${pageTitle || '(sem título)'} — ${pageUrl}`,
    '',
    'Regras:',
    '- Retorne APENAS um JSON object com a chave "items" contendo um array. Exemplo: {"items":[{...},{...}]}. Sem markdown, sem explicação.',
    '- Cada item tem: name (obrigatório), price (número em BRL ou null), region (string ou null), description (string curta, max 200 chars, ou null), image_url (string ou null), images (array de strings com TODAS as URLs de foto desse item, ou []), url (link para página de detalhes do item, ou null), type ("venda" | "aluguel" | null).',
    '- Se a página NÃO listar itens (ex: é um blog, contato, sobre), retorne [].',
    '- Máximo 30 itens. Se houver mais, pegue os 30 primeiros.',
    '- price: extraia o valor numérico. "R$ 1.234,56" → 1234.56. "1.500/mês" → 1500. Sem moeda no JSON.',
    '- type: detecte se é venda ou aluguel. Pistas de ALUGUEL: "alugar", "aluguel", "locação", "/mês", "mensal", preço entre R$300 e R$10.000 sem ser produto. Pistas de VENDA: "à venda", "venda", "comprar", preço acima de R$50.000. Se não der pra saber, use null.',
    '- image_url: o texto contém marcadores `[IMG: <url>]` em volta dos itens — esses são as URLs reais das fotos do site. Para cada item, escolha a URL [IMG:] que está MAIS PRÓXIMA do nome dele no texto. Use a URL EXATA, sem mudar. Se não houver [IMG:] perto, use null. NÃO invente URL.',
    '- Não invente nada. Se um campo não está claro, use null.',
    '',
    'Texto da página:',
    '"""',
    visibleText,
    '"""',
  ].join('\n');

  const call = await callExtractionJson(prompt, 4096, 60_000);
  if (!call.ok) {
    warnings.push(`Extractor: ${call.error.slice(0, 600)}`);
    return { items: [], warnings };
  }
  try {
    const text = call.text;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      // Recover JSON wrapped in fences or extra prose.
      const m = text.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
      if (m) {
        try { parsed = JSON.parse(m[0]); }
        catch {
          warnings.push(`${call.provider} retornou JSON inválido`);
          return { items: [], warnings };
        }
      } else {
        warnings.push(`${call.provider} retornou texto sem JSON`);
        return { items: [], warnings };
      }
    }
    // Accept either array (legacy Gemini format) or {items:[...]}
    // (current uniform format) so model swaps don't require code changes.
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const obj = parsed as { items?: unknown };
      if (Array.isArray(obj.items)) parsed = obj.items;
    }
    if (!Array.isArray(parsed)) {
      warnings.push(`${call.provider} retornou objeto sem chave items`);
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
      const typeRaw = strFromAny(r.type);
      if (typeRaw === 'venda' || typeRaw === 'aluguel') item.type = typeRaw;
      const resolveUrl = (raw: unknown): string | undefined => {
        const s = strFromAny(raw);
        if (!s) return undefined;
        if (/^https?:\/\//i.test(s)) return s;
        try { return new URL(s, pageUrl).toString(); } catch { return undefined; }
      };
      const image = resolveUrl(r.image_url);
      if (image) item.image_url = image;
      // Optional images array (deep-crawl detail pages return many).
      const imagesRaw = (r as { images?: unknown }).images;
      if (Array.isArray(imagesRaw)) {
        const list = imagesRaw
          .map(resolveUrl)
          .filter((u): u is string => !!u && isListingImageUrl(u))
          .slice(0, 6);
        // Dedup + ensure cover photo (image_url) is first when present.
        const dedup = Array.from(new Set(list));
        if (item.image_url && !dedup.includes(item.image_url)) dedup.unshift(item.image_url);
        if (dedup.length) {
          item.images = dedup;
          if (!item.image_url) item.image_url = dedup[0];
        }
      }
      const itemUrl = resolveUrl((r as { url?: unknown }).url);
      if (itemUrl) item.url = itemUrl;
      items.push(item);
    }
    return { items, warnings };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    warnings.push(`Falha parse: ${msg}`);
    return { items: [], warnings };
  }
}

// Listing-style URL detector — used by both sitemap parser and HTML link
// scanner so the same heuristics apply regardless of where the URL came
// from. Path patterns cover BR real-estate, e-commerce, auto verticals.
const LISTING_PATH_TOKENS =
  /\/(imove(l|is)|imobiliari[ao]|propert(y|ies)|listing|anuncio|anuncios|produto|produtos|product|products|carro|carros|veiculo|veiculos|vehicle|vehicles|auto|moto|casa|apartamento|item|catalog|loja|loja-virtual|comprar|alugar|aluguel|locacao|venda|seminovos|usados|estoque)(\/|\?|-|_|=)/i;
// Numeric id-style fallback for sites that put the id first (e.g.
// /2122/imoveis/locacao-..., /detail/12345, /imovel/12345.html)
const LISTING_ID_TOKEN = /\/\d{3,}\/|\/[a-z0-9-]*(\d{3,})(?:\.html?|\.php)?(?:\?|#|$)/i;
const LISTING_SKIP_PATH =
  /\/(login|cart|carrinho|checkout|cadastro|register|wp-(admin|login|content)|cdn-cgi|search|busca|filtro|page|pagina|tag|categoria|category|blog|sobre|contato|faq|sitemap|robots|favicon|atendimento|politica|termos|noticias|imprensa)(\/|\?|$)/i;

function isLikelyListingUrl(u: URL): boolean {
  if (LISTING_SKIP_PATH.test(u.pathname)) return false;
  return LISTING_PATH_TOKENS.test(u.pathname) || LISTING_ID_TOKEN.test(u.pathname);
}

/**
 * Try to read the site's sitemap.xml (or sitemap_index.xml + nested
 * sitemaps) for the COMPLETE list of URLs. Sitemap is the source of
 * truth — beats walking pagination + scraping links. Returns up to
 * `max` listing-shaped URLs after filtering.
 */
async function fetchSitemapUrls(baseUrl: string, max: number): Promise<string[]> {
  const base = new URL(baseUrl);
  const candidates = [
    `${base.origin}/sitemap.xml`,
    `${base.origin}/sitemap_index.xml`,
    `${base.origin}/sitemap-index.xml`,
  ];
  const out = new Set<string>();
  const visited = new Set<string>();

  async function pull(url: string, depth = 0): Promise<void> {
    if (depth > 2 || visited.has(url) || out.size >= max) return;
    visited.add(url);
    const r = await fetchHtmlBounded(url, 6_000, 1_500_000);
    if (!r.ok) return;
    // Parse <loc>...</loc> entries (works for both urlset and sitemapindex)
    const locRe = /<loc>([^<]+)<\/loc>/gi;
    let m: RegExpExecArray | null;
    const nestedSitemaps: string[] = [];
    while ((m = locRe.exec(r.html)) !== null) {
      if (out.size >= max) break;
      const loc = m[1].trim();
      if (!loc) continue;
      // If <loc> points at another .xml, it's a nested sitemap (index file)
      if (/\.xml(?:\.gz)?(?:\?|#|$)/i.test(loc)) {
        nestedSitemaps.push(loc);
        continue;
      }
      let u: URL;
      try { u = new URL(loc); } catch { continue; }
      if (u.origin !== base.origin) continue;
      // Strip the home/root URL itself and any path matching the input
      if (u.pathname === '/' || u.pathname === '') continue;
      if (u.href.replace(/[#?].*$/, '') === baseUrl.replace(/[#?].*$/, '')) continue;
      if (!isLikelyListingUrl(u)) continue;
      u.hash = '';
      out.add(u.toString());
    }
    for (const ns of nestedSitemaps) {
      if (out.size >= max) break;
      await pull(ns, depth + 1);
    }
  }

  for (const c of candidates) {
    if (out.size >= max) break;
    await pull(c);
  }
  return Array.from(out);
}

/**
 * Find candidate detail-page URLs from a listing/index page. Used as
 * fallback when sitemap.xml is missing/empty. Scans <a href> tags only.
 */
function extractListingUrls(html: string, baseUrl: string, max: number): string[] {
  const base = new URL(baseUrl);
  const out = new Set<string>();
  const re = /<a\b[^>]+href=["']([^"']+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const href = m[1].trim();
    if (!href || href.startsWith('#') || /^(mailto|tel|javascript):/i.test(href)) continue;
    if (/\.(jpe?g|png|webp|gif|svg|css|js|pdf|zip|xml|json|ico|woff2?)(?:\?|#|$)/i.test(href)) continue;
    let u: URL;
    try { u = new URL(href, baseUrl); } catch { continue; }
    if (u.origin !== base.origin) continue;
    if (u.href.replace(/[#?].*$/, '') === baseUrl.replace(/[#?].*$/, '')) continue;
    if (isLikelyListingUrl(u)) {
      u.hash = '';
      out.add(u.toString());
      if (out.size >= max) break;
    }
  }
  return Array.from(out);
}

/** Fetch HTML with byte cap + timeout. Refactored from importCatalogFromUrl
 *  so deep-crawl can reuse the exact same hardening (SSRF guard already
 *  ran on the parent URL; detail URLs are same-origin so we trust them). */
async function fetchHtmlBounded(
  url: string,
  timeoutMs: number,
  maxBytes: number,
): Promise<{ ok: true; html: string; title?: string } | { ok: false; error: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
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
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const ctype = res.headers.get('content-type') || '';
    if (!/html|xml/i.test(ctype)) return { ok: false, error: `not HTML (${ctype})` };
    const reader = res.body?.getReader();
    let html: string;
    if (!reader) {
      html = await res.text();
    } else {
      const chunks: Uint8Array[] = [];
      let total = 0;
      while (total < maxBytes) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        total += value.byteLength;
      }
      try { await reader.cancel(); } catch { /* ignore */ }
      const buf = new Uint8Array(Math.min(total, maxBytes));
      let off = 0;
      for (const ch of chunks) {
        const take = Math.min(ch.byteLength, buf.length - off);
        buf.set(ch.subarray(0, take), off);
        off += take;
        if (off >= buf.length) break;
      }
      html = new TextDecoder('utf-8', { fatal: false }).decode(buf);
    }
    return { ok: true, html, title: extractTitle(html) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * LLM extraction tuned for a single-listing detail page (one item, lots
 * of detail). Different from llmExtract which expects a list page. Used
 * by deepCrawl to enrich each item with full info + photo gallery.
 */
async function llmExtractDetailPage(
  visibleText: string,
  pageUrl: string,
  pageTitle?: string,
): Promise<CatalogItem | null> {
  if (!process.env.GEMINI_API_KEY && !process.env.GROQ_API_KEY && !process.env.SILICONFLOW_API_KEY) return null;
  const prompt = [
    'Você está lendo a PÁGINA DE DETALHES de UM ÚNICO item (um imóvel, carro, produto, serviço) no site. Extraia toda a informação relevante.',
    `URL: ${pageUrl}`,
    `Título: ${pageTitle || '(sem título)'}`,
    '',
    'Retorne APENAS um objeto JSON único (não array), com:',
    '- name: nome/título do item (ex: "Casa 3 quartos no Itaim", "Honda Civic 2020").',
    '- price: número em BRL (ou null se não tiver). "R$ 1.234,56" → 1234.56.',
    '- type: "venda" | "aluguel" | null (detecte por palavras como "à venda", "aluguel", "/mês").',
    '- region: bairro, cidade ou área de cobertura.',
    '- description: descrição completa, até 600 chars (m², quartos, banheiros, vagas, amenidades, condição, etc).',
    '- image_url: a foto de capa (a primeira do gallery).',
    '- images: array com TODAS as URLs de fotos do item (cap 6). Use marcadores [IMG: <url>] que aparecem no texto. Use URLs EXATAS, não invente.',
    '',
    'Se a página NÃO é detalhe de um item (é blog, contato, listagem), retorne null.',
    '',
    'Texto da página:',
    '"""',
    visibleText,
    '"""',
  ].join('\n');

  const call = await callExtractionJson(prompt, 2048, 35_000);
  if (!call.ok) return null;
  const text = call.text;
  let parsed: unknown;
  try { parsed = JSON.parse(text); }
  catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) { try { parsed = JSON.parse(m[0]); } catch { return null; } }
    else return null;
  }
  try {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const r = parsed as Record<string, unknown>;
    const name = strFromAny(r.name);
    if (!name) return null;
    const item: CatalogItem = { id: shortHash(name + ':' + pageUrl), name, url: pageUrl };
    const price = priceFromAny(r.price);
    if (price !== undefined) item.price = price;
    const region = strFromAny(r.region);
    if (region) item.region = region;
    const description = strFromAny(r.description, 800);
    if (description) item.description = description;
    const typeRaw = strFromAny(r.type);
    if (typeRaw === 'venda' || typeRaw === 'aluguel') item.type = typeRaw;
    const resolve = (v: unknown): string | undefined => {
      const s = strFromAny(v);
      if (!s) return undefined;
      if (/^https?:\/\//i.test(s)) return s;
      try { return new URL(s, pageUrl).toString(); } catch { return undefined; }
    };
    const cover = resolve(r.image_url);
    if (cover) item.image_url = cover;
    if (Array.isArray(r.images)) {
      const list = (r.images as unknown[])
        .map(resolve)
        .filter((u): u is string => !!u && isListingImageUrl(u))
        .slice(0, 6);
      const dedup = Array.from(new Set(list));
      if (cover && !dedup.includes(cover)) dedup.unshift(cover);
      if (dedup.length) {
        item.images = dedup;
        if (!item.image_url) item.image_url = dedup[0];
      }
    }
    return item;
  } catch {
    return null;
  }
}

/**
 * Run detail-page extractions in parallel chunks. Concurrency 5 keeps
 * under most sites' soft rate-limits + Gemini's per-second cap, while
 * still finishing 20 items in ~12s. Returns whatever extracted
 * successfully — partial results are useful.
 */
async function deepCrawlDetailPages(
  urls: string[],
  concurrency = 5,
): Promise<{ items: CatalogItem[]; failed: number }> {
  const results: CatalogItem[] = [];
  let failed = 0;
  for (let i = 0; i < urls.length; i += concurrency) {
    const batch = urls.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map(async (u) => {
        const fetched = await fetchHtmlBounded(u, 8_000, 600_000);
        if (!fetched.ok) return null;
        const text = htmlToVisibleText(fetched.html);
        if (text.length < 100) return null;
        return llmExtractDetailPage(text, u, fetched.title);
      }),
    );
    for (const r of batchResults) {
      if (r) results.push(r);
      else failed++;
    }
  }
  return { items: results, failed };
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

  // Pass 1: structured data — collects items AND business profile in
  // one HTML walk. Business info is best-effort; we always try to fill
  // it from meta + heuristics even if items came back empty.
  const { items: jsonldItems, business: jsonldBusiness } = extractFromJsonLd(html, url);
  let business = jsonldBusiness;
  business = mergeBusiness(business, extractMetaBusiness(html, url));
  business = extractContactsFromHtml(html, business);
  // Last-resort name fallback from <title> tag — many small business
  // sites (WordPress, Wix templates) skip JSON-LD Organization but
  // their page title is "Imobiliária X" / "Loja Y" / etc. Without
  // this, the rename pill never appears for those owners.
  if (!business.name) {
    const fromTitle = nameFromTitle(pageTitle);
    if (fromTitle) business.name = fromTitle;
  }
  const businessInfoText = formatBusinessInfo(business, pageTitle);

  if (jsonldItems.length >= 3) {
    log.info('site-importer.jsonld_hit', {
      url,
      items: jsonldItems.length,
      business_fields: Object.keys(business).length,
    });
    return {
      ok: true,
      items: jsonldItems.slice(0, MAX_ITEMS),
      source: 'jsonld',
      warnings,
      page_title: pageTitle,
      business,
      business_info_text: businessInfoText || undefined,
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
      business,
      business_info_text: businessInfoText || undefined,
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
    // Even with no items, hand back business info if we found any —
    // owner can still benefit from auto-filled name/phone/address.
    return {
      ok: false,
      items: [],
      source: 'none',
      warnings,
      error:
        'Não consegui extrair itens. Tente colar a URL da página de listagem (ex: /imoveis, /carros, /produtos) em vez da home.',
      page_title: pageTitle,
      business,
      business_info_text: businessInfoText || undefined,
    };
  }

  // ─── Deep crawl pass — fetch each item's detail page in parallel
  // for richer data: full description (m², quartos, amenidades), photo
  // gallery, exact transaction type, structured attributes the home/list
  // page didn't surface.
  //
  // URL discovery: try sitemap.xml first (source of truth, sites with
  // 100s of listings expose them all there). Fallback to scraping
  // <a href> from the home page when sitemap is missing/empty.
  // Capped at 50 items: 50 × ~1.5s avg with concurrency 8 ≈ 10-15s.
  const SITE_CRAWL_CAP = Number(process.env.SITE_CRAWL_CAP) || 50;
  let detailUrls = await fetchSitemapUrls(url, SITE_CRAWL_CAP);
  let urlSource = 'sitemap';
  if (detailUrls.length < 5) {
    const fromHtml = extractListingUrls(html, url, SITE_CRAWL_CAP);
    if (fromHtml.length > detailUrls.length) {
      detailUrls = fromHtml;
      urlSource = 'html';
    }
  }
  log.info('site-importer.detail_urls', { source: urlSource, count: detailUrls.length });
  let deepCount = 0;
  if (detailUrls.length > 0) {
    const t0 = Date.now();
    const deep = await deepCrawlDetailPages(detailUrls, 8);
    deepCount = deep.items.length;
    log.info('site-importer.deep_crawl', {
      attempted: detailUrls.length,
      success: deep.items.length,
      failed: deep.failed,
      ms: Date.now() - t0,
    });
    if (deep.failed > 0) {
      warnings.push(`Deep crawl: ${deep.failed} de ${detailUrls.length} páginas de detalhe falharam (timeout ou anti-bot).`);
    }
    // Merge strategy: deep-crawled items REPLACE list-page versions when
    // their names overlap. Detail items are richer (full desc + gallery)
    // so we always prefer them. Names that only appear on the list page
    // stay as-is (best-effort partial coverage).
    const byName = new Map<string, CatalogItem>();
    for (const it of merged) byName.set(it.name.toLowerCase().slice(0, 50), it);
    for (const it of deep.items) {
      const key = it.name.toLowerCase().slice(0, 50);
      const existing = byName.get(key);
      if (existing) {
        // Merge: keep best price/region from either, prefer detail's
        // description + images + url + type.
        byName.set(key, {
          ...existing,
          ...it,
          price: it.price ?? existing.price,
          region: it.region || existing.region,
          // image_url: existing might already point at the cover photo
          // from the list page; if detail has a gallery, use its first.
          image_url: it.image_url || existing.image_url,
          images: it.images && it.images.length ? it.images : existing.images,
          type: it.type || existing.type,
        });
      } else {
        // Detail item with name we didn't see on the list page — keep it.
        byName.set(key, it);
      }
    }
    // Re-cap at MAX_ITEMS in case we accumulated more.
    const finalList = Array.from(byName.values()).slice(0, MAX_ITEMS);
    merged.length = 0;
    merged.push(...finalList);
  }

  log.info('site-importer.success', {
    url,
    jsonld: jsonldItems.length,
    llm: llm.items.length,
    deep: deepCount,
    final: merged.length,
    business_fields: Object.keys(business).length,
  });
  return {
    ok: true,
    items: merged,
    source: jsonldItems.length && llm.items.length ? 'mixed' : jsonldItems.length ? 'jsonld' : 'llm',
    warnings,
    page_title: pageTitle,
    business,
    business_info_text: businessInfoText || undefined,
  };
}
