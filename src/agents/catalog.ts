/**
 * Agent catalog: structured inventory parsing + normalization.
 *
 * Owner uploads a CSV or JSON file of items the agent should
 * recognize as REAL inventory (instead of inventing). The parser is
 * intentionally lenient on column names — owners come from spreadsheet
 * software where headers vary ("Preço" vs "price" vs "Valor"). We
 * detect well-known fields by alias and store everything else as
 * `meta` so the agent can still reference any column the owner cared
 * about.
 *
 * Output shape (one item):
 *   {
 *     id: string,            // stable id (caller provides or we hash)
 *     name: string,          // human-readable label, required
 *     price: number?,        // BRL (numeric), optional
 *     region: string?,       // bairro/cidade, optional
 *     description: string?,  // free text, optional
 *     image_url: string?,    // first http(s) URL we find, optional
 *     meta: Record<string, string>  // every other column verbatim
 *   }
 */

export interface CatalogItem {
  id: string;
  name: string;
  price?: number;
  region?: string;
  description?: string;
  image_url?: string;
  meta?: Record<string, string>;
}

export interface ParseResult {
  items: CatalogItem[];
  warnings: string[];
  /** Raw header → normalized field mapping for the operator UI. */
  fieldMap: Record<string, string>;
}

// Aliases per well-known field. Lowercased before lookup.
const ALIASES: Record<string, string[]> = {
  name:        ['name', 'nome', 'titulo', 'título', 'title', 'modelo', 'produto', 'item', 'descrição_curta'],
  price:       ['price', 'preco', 'preço', 'valor', 'value', 'cost', 'custo', 'rs', 'r$'],
  region:      ['region', 'regiao', 'região', 'bairro', 'cidade', 'city', 'neighborhood', 'localizacao', 'localização', 'endereco', 'endereço'],
  description: ['description', 'descricao', 'descrição', 'desc', 'detalhes', 'observacao', 'observação', 'obs'],
  image_url:   ['image', 'imagem', 'image_url', 'foto', 'photo', 'url', 'link', 'href'],
  id:          ['id', 'codigo', 'código', 'code', 'sku', 'ref', 'referencia', 'referência'],
};

const MAX_ITEMS = 1000;

function pickField(field: keyof typeof ALIASES, headers: string[]): string | null {
  const lc = headers.map((h) => h.toLowerCase().trim());
  for (const alias of ALIASES[field]) {
    const idx = lc.indexOf(alias);
    if (idx >= 0) return headers[idx];
  }
  return null;
}

function parsePrice(raw: unknown): number | undefined {
  if (raw === null || raw === undefined) return undefined;
  const s = String(raw).trim();
  if (!s) return undefined;
  // Brazilian formats: "R$ 1.234,56" / "1234,56" / "1234.56" / "1234"
  const cleaned = s
    .replace(/r\$|reais|brl/gi, '')
    .replace(/\s/g, '')
    .replace(/\.(?=\d{3}(?:\D|$))/g, '') // 1.234 → 1234 (thousand sep)
    .replace(',', '.');                   // 1234,56 → 1234.56
  const n = Number(cleaned);
  return isFinite(n) ? n : undefined;
}

function shortHash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36).slice(0, 8);
}

function normalizeRow(
  raw: Record<string, unknown>,
  fields: Record<string, string | null>,
  rowIdx: number,
): CatalogItem | null {
  const get = (key: keyof typeof ALIASES) => {
    const col = fields[key];
    if (!col) return undefined;
    const v = raw[col];
    return v === null || v === undefined ? undefined : String(v).trim();
  };

  const name = get('name');
  if (!name) return null; // rows with no identifier are useless

  const item: CatalogItem = {
    id: get('id') || shortHash(name + ':' + rowIdx),
    name,
  };
  const priceRaw = get('price');
  if (priceRaw) {
    const p = parsePrice(priceRaw);
    if (p !== undefined) item.price = p;
  }
  const region = get('region');
  if (region) item.region = region;
  const desc = get('description');
  if (desc) item.description = desc;
  const img = get('image_url');
  if (img && /^https?:\/\//i.test(img)) item.image_url = img;

  // Stash any remaining columns under meta — owner gets to keep
  // their custom fields without us prescribing a schema.
  const known = new Set(Object.values(fields).filter(Boolean) as string[]);
  const meta: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (known.has(k)) continue;
    if (v === null || v === undefined) continue;
    const sv = String(v).trim();
    if (sv) meta[k] = sv;
  }
  if (Object.keys(meta).length) item.meta = meta;
  return item;
}

/**
 * Minimal RFC-4180-ish CSV/TSV parser. Auto-detects the delimiter
 * (comma vs tab vs semicolon) by sniffing the first line — Excel
 * exports vary by region (tab on copy-paste, semicolon in pt-BR
 * Excel, comma in plain CSV). Handles quoted fields with embedded
 * delimiters + escaped quotes (""). Inline so we don't pay a 30kb
 * dependency for a one-shot upload path.
 */
function detectDelimiter(text: string): string {
  // Sample the first line. Whichever candidate appears most wins,
  // with tab biased highest because spreadsheet copy-paste is tab-
  // separated and end users will almost always paste from Excel/
  // Sheets rather than hand-craft a comma list.
  const firstLine = text.split('\n')[0] || '';
  const counts = {
    '\t': (firstLine.match(/\t/g) || []).length,
    ';':  (firstLine.match(/;/g) || []).length,
    ',':  (firstLine.match(/,/g) || []).length,
  };
  if (counts['\t'] > 0) return '\t';
  if (counts[';'] > counts[',']) return ';';
  return ',';
}

function parseCsv(text: string, delim?: string): Record<string, string>[] {
  const sep = delim || detectDelimiter(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuote = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuote) {
      if (c === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; }
        else inQuote = false;
      } else {
        cell += c;
      }
    } else {
      if (c === '"' && cell === '') { inQuote = true; }
      else if (c === sep) { row.push(cell); cell = ''; }
      else if (c === '\r') { /* skip */ }
      else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
      else { cell += c; }
    }
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  if (rows.length < 2) return [];
  const headers = rows[0].map((h) => h.trim());
  return rows.slice(1)
    .filter((r) => r.some((c) => c.trim() !== ''))
    .map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? ''])));
}

export function parseCatalog(content: string, mimeOrFormat: string): ParseResult {
  const isJson = /json/i.test(mimeOrFormat) || content.trim().startsWith('[') || content.trim().startsWith('{');
  let raw: Record<string, unknown>[] = [];
  const warnings: string[] = [];
  try {
    if (isJson) {
      const parsed = JSON.parse(content);
      if (Array.isArray(parsed)) raw = parsed;
      else if (Array.isArray((parsed as { items?: unknown }).items)) {
        raw = (parsed as { items: Record<string, unknown>[] }).items;
      } else {
        warnings.push('JSON deve ser um array de items, ou um objeto com a chave "items".');
        return { items: [], warnings, fieldMap: {} };
      }
    } else {
      raw = parseCsv(content);
    }
  } catch (err) {
    warnings.push('Falha ao ler arquivo: ' + (err instanceof Error ? err.message : String(err)));
    return { items: [], warnings, fieldMap: {} };
  }

  if (raw.length === 0) {
    warnings.push('Nenhuma linha encontrada no arquivo.');
    return { items: [], warnings, fieldMap: {} };
  }

  if (raw.length > MAX_ITEMS) {
    warnings.push(`Catálogo truncado em ${MAX_ITEMS} itens (recebidos ${raw.length}). Considere dividir em mais agentes.`);
    raw = raw.slice(0, MAX_ITEMS);
  }

  const headers = Object.keys(raw[0] ?? {});
  const fields = {
    id: pickField('id', headers),
    name: pickField('name', headers),
    price: pickField('price', headers),
    region: pickField('region', headers),
    description: pickField('description', headers),
    image_url: pickField('image_url', headers),
  };

  if (!fields.name) {
    warnings.push(
      'Não consegui detectar a coluna de nome (procurei: ' +
        ALIASES.name.join(', ') + '). Renomeie sua coluna de identificador para algo similar.',
    );
    return { items: [], warnings, fieldMap: {} };
  }

  const items: CatalogItem[] = [];
  for (let i = 0; i < raw.length; i++) {
    const item = normalizeRow(raw[i], fields, i);
    if (item) items.push(item);
  }

  if (items.length === 0) {
    warnings.push('Nenhuma linha válida (todas sem nome).');
  } else if (items.length < raw.length) {
    warnings.push(`${raw.length - items.length} linhas ignoradas (sem nome ou vazias).`);
  }

  const fieldMap: Record<string, string> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v) fieldMap[k] = v;
  }
  return { items, warnings, fieldMap };
}

/**
 * Compact rendering for the system prompt — the LLM gets a preview
 * (first N items + counts) so it knows what's available without
 * blowing the context window. Detailed lookups go through the
 * search_catalog tool.
 */
export function renderCatalogContext(items: CatalogItem[], previewLimit = 12): string {
  if (!Array.isArray(items) || items.length === 0) return '';
  const total = items.length;
  const regions = new Set(items.map((i) => i.region).filter(Boolean));
  const priceList = items.map((i) => i.price).filter((p): p is number => typeof p === 'number');
  const priceLine = priceList.length
    ? `Faixa de preço: R$ ${Math.min(...priceList).toFixed(2)} – R$ ${Math.max(...priceList).toFixed(2)}.`
    : '';
  const regionLine = regions.size
    ? `Regiões cobertas: ${[...regions].slice(0, 8).join(', ')}${regions.size > 8 ? ` (+${regions.size - 8})` : ''}.`
    : '';

  const preview = items.slice(0, previewLimit).map((i) => {
    const parts = [`• ${i.name}`];
    if (i.price !== undefined) parts.push(`R$${i.price.toFixed(2)}`);
    if (i.region) parts.push(i.region);
    if (i.description) parts.push(`— ${i.description.slice(0, 80)}`);
    return parts.join(' · ');
  });

  return [
    `## Catálogo (fonte de verdade — ${total} itens disponíveis)`,
    'NUNCA invente item fora do catálogo. Se o cliente pediu algo que NÃO está aqui, fala honesto: "não tenho isso em estoque hoje, mas tenho [alternativa do catálogo]".',
    priceLine,
    regionLine,
    total > previewLimit
      ? `\nAmostra (${previewLimit} de ${total} itens — use search_catalog pra filtrar mais):`
      : `\nItens disponíveis:`,
    ...preview,
    total > previewLimit ? `\n... e mais ${total - previewLimit} itens. Use search_catalog(query) pra puxar matches específicos.` : '',
  ].filter(Boolean).join('\n');
}

/** Filter catalog by free-text query — case-insensitive substring
 *  match across name + description + region + meta values. Used by
 *  the search_catalog tool to give the agent dynamic lookups when
 *  the inline preview isn't enough. */
export function searchCatalog(items: CatalogItem[], query: string, limit = 10): CatalogItem[] {
  if (!query || !Array.isArray(items)) return [];
  const q = query.toLowerCase().trim();
  if (!q) return [];
  const scored: Array<{ item: CatalogItem; score: number }> = [];
  for (const item of items) {
    let score = 0;
    if (item.name?.toLowerCase().includes(q)) score += 5;
    if (item.region?.toLowerCase().includes(q)) score += 3;
    if (item.description?.toLowerCase().includes(q)) score += 2;
    if (item.meta) {
      for (const v of Object.values(item.meta)) {
        if (String(v).toLowerCase().includes(q)) { score += 1; break; }
      }
    }
    if (score > 0) scored.push({ item, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((s) => s.item);
}
