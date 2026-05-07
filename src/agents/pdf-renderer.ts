/**
 * PDF rendering for agent-generated documents.
 *
 * Used by the `generate_pdf` tool — agent calls it to produce
 * comprovantes / agendamentos / fichas / contratos / receitas
 * dynamically and the result is delivered to the customer via WhatsApp
 * sendMedia(mediatype:'document').
 *
 * Design choices:
 *   - pdfkit (CommonJS, well-maintained, ~700KB). Renders a clean
 *     A4 single-column document with header/body/sections/footer.
 *   - Built-in Helvetica handles BR accents (á, ç, ã) via WinAnsi
 *     encoding — no TTF embedding needed.
 *   - Returns a Node Buffer; caller base64-encodes for Evolution and
 *     for storage upload.
 *   - No customer-facing branding by default (no logo) — keeps the
 *     dependency small. Owner can set business name, that becomes the
 *     header. Logo embedding is a Phase 4 concern.
 */
import PDFDocument from 'pdfkit';

export interface PdfSection {
  heading: string;
  content: string;
}

export interface PdfRenderInput {
  /** Bold title at the top of the document. e.g. "Comprovante de Agendamento". */
  title: string;
  /** First paragraph after the title. The high-signal summary. */
  body: string;
  /** Optional structured sections after the body. */
  sections?: PdfSection[];
  /** Owner-configured business name shown above the title. Optional. */
  businessName?: string;
  /** Optional footer line — default is the generation timestamp in PT-BR. */
  footer?: string;
}

const PAGE_MARGIN = 56;     // ~2cm
const HEADER_GAP  = 16;
const SECTION_GAP = 12;

/**
 * Render the PDF and return its full Buffer (Bun Buffer compatible).
 *
 * Implementation note: PDFKit streams chunks; we accumulate into an
 * array of Uint8Array and concatenate at end() — simpler than the
 * stream-to-buffer dance for this scale (1-2 page docs are <50KB).
 */
export async function renderPdf(input: PdfRenderInput): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: 'A4',
        margin: PAGE_MARGIN,
        info: {
          Title: input.title.slice(0, 200),
          Producer: 'Axon Agent',
          Creator: 'Axon Agent',
        },
      });

      const chunks: Uint8Array[] = [];
      doc.on('data', (chunk: Uint8Array | Buffer) => {
        chunks.push(chunk instanceof Buffer ? new Uint8Array(chunk) : chunk);
      });
      doc.on('end', () => {
        const total = chunks.reduce((sum, c) => sum + c.length, 0);
        const out = Buffer.alloc(total);
        let offset = 0;
        for (const c of chunks) { out.set(c, offset); offset += c.length; }
        resolve(out);
      });
      doc.on('error', reject);

      // ─── Header (business name) ────────────────────────────
      if (input.businessName && input.businessName.trim()) {
        doc.font('Helvetica-Bold').fontSize(10);
        doc.fillColor('#888888').text(input.businessName.trim().slice(0, 80), {
          align: 'right',
        });
        doc.moveDown(0.5);
        doc.fillColor('#000000');
      }

      // ─── Title ─────────────────────────────────────────────
      doc.font('Helvetica-Bold').fontSize(18);
      doc.text(input.title.trim().slice(0, 200));
      doc.moveDown(0.3);

      // Thin horizontal rule under the title
      const ruleY = doc.y;
      doc
        .strokeColor('#dddddd')
        .lineWidth(1)
        .moveTo(PAGE_MARGIN, ruleY)
        .lineTo(doc.page.width - PAGE_MARGIN, ruleY)
        .stroke();
      doc.strokeColor('#000000');
      doc.moveDown(0.7);

      // ─── Body ──────────────────────────────────────────────
      doc.font('Helvetica').fontSize(11);
      doc.text(input.body.trim(), { align: 'left', lineGap: 2 });

      // ─── Sections ──────────────────────────────────────────
      if (input.sections && input.sections.length > 0) {
        doc.moveDown(1);
        for (const section of input.sections.slice(0, 20)) {
          if (!section.heading || !section.content) continue;
          doc.font('Helvetica-Bold').fontSize(11);
          doc.text(section.heading.trim().slice(0, 120));
          doc.moveDown(0.2);
          doc.font('Helvetica').fontSize(10);
          doc.text(section.content.trim().slice(0, 4000), { lineGap: 2 });
          doc.moveDown(0.6);
        }
      }

      // ─── Footer ────────────────────────────────────────────
      const footerText =
        input.footer ||
        `Documento gerado em ${new Date().toLocaleString('pt-BR', {
          timeZone: 'America/Sao_Paulo',
        })}`;
      const bottomMargin = PAGE_MARGIN;
      doc.font('Helvetica').fontSize(8).fillColor('#999999');
      doc.text(
        footerText,
        PAGE_MARGIN,
        doc.page.height - bottomMargin - HEADER_GAP,
        { align: 'center', width: doc.page.width - 2 * PAGE_MARGIN },
      );
      doc.fillColor('#000000');

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * Tiny helper: build a sensible filename for the generated PDF.
 *
 * Outputs e.g. "comprovante-agendamento-2026-05-02.pdf". Keep it short
 * and ASCII so it travels well through filesystems / WhatsApp / Supabase.
 */
export function suggestPdfFilename(title: string): string {
  const slug =
    title
      .toLowerCase()
      .normalize('NFD')
      // Strip Unicode combining marks (U+0300..U+036F) — covers PT-BR
      // accents (á, ç, ã, é, etc) so the filename stays ASCII.
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'documento';
  const date = new Date().toISOString().slice(0, 10);
  return `${slug}-${date}.pdf`;
}

// Keep SECTION_GAP exported as a constant in case future layouts need it.
export { SECTION_GAP };

// ───────────────────────────────────────────────────────────────────
// Catalog PDF — separate from renderPdf because the layout is grid-based
// (2-col cards with embedded photos), not flowing single-column prose.
// Used by the send_catalog_pdf tool when a customer asks for the full
// catalog instead of a single listing photo.
// ───────────────────────────────────────────────────────────────────

export interface CatalogPdfItem {
  /** Catalog ID/REF — surfaced prominently on each card so the customer
   *  can reference an item by code ("quero saber mais sobre o IM-A1B2").
   *  When omitted, renderCatalogPdf derives a stable short code from
   *  the item name. */
  id?: string;
  name: string;
  price?: number | null;
  region?: string | null;
  description?: string | null;
  image_url?: string | null;
  /** Full photo gallery — populated by the importer for detail pages
   *  with multiple shots. Brochure renderer uses these for the "Galeria"
   *  page. Catalog grid renderer uses only image_url. */
  images?: string[];
  url?: string | null;
  /** Real-estate / multi-modal catalogs: 'venda' (for sale) | 'aluguel'
   *  (for rent). Used to split the PDF into sections so the customer
   *  sees comparable items grouped together. Items without `type` go
   *  into a third "Outros" section. */
  type?: 'venda' | 'aluguel' | null;
}

export interface CatalogPdfInput {
  /** Owner business name shown on the cover. */
  businessName: string;
  /** Optional one-line contact info under the business name on the cover (phone / address). */
  businessContact?: string;
  /** Optional public website URL — printed on the cover footer + on every
   *  page footer so the customer always knows where to go to see more
   *  detail / make an inquiry. When omitted, renderCatalogPdf tries to
   *  derive it from the origin of the first item.url. */
  siteUrl?: string;
  /** Items to render. Caller is expected to have already filtered + capped. */
  items: CatalogPdfItem[];
}

/**
 * Detect the property type from the item's name + description for
 * real-estate catalogs. Returns one of: casa | apartamento | terreno |
 * sitio | sala | cobertura | kitnet | outro. Used to sub-group items
 * within a transaction-type section so the customer browsing for "uma
 * casa para alugar" sees houses together instead of mixed with apartments
 * and lots.
 *
 * Naive substring match — works for ~95% of Brazilian real-estate
 * catalogs because owners tend to start the listing name with the type
 * ("Casa em Pontal...", "Apartamento no Centro", "Terreno em Lot..."
 * etc). False positives are bounded to "outro" which still renders
 * correctly, just without the kind-grouping benefit.
 */
function detectPropertyKind(item: CatalogPdfItem):
  | 'casa'
  | 'apartamento'
  | 'terreno'
  | 'sitio'
  | 'sala'
  | 'cobertura'
  | 'kitnet'
  | 'outro' {
  const text = `${item.name || ''} ${item.description || ''}`.toLowerCase();
  // Order matters: more-specific matches first so "casa de praia" doesn't
  // win over the actual "casa" category.
  if (/\bkitnet|\bkit\s*net|\bstudio\b/.test(text)) return 'kitnet';
  if (/\bcobertura|\bduplex|\btriplex/.test(text)) return 'cobertura';
  if (/\bapartamento|\bapto\.?\b|\bap\.?\s*\d|\bflat\b/.test(text)) return 'apartamento';
  if (/\bs[ií]tio|\bch[áa]cara|\bfazenda|\brural\b/.test(text)) return 'sitio';
  if (/\bterreno|\blote\b|\báreas?\b/.test(text)) return 'terreno';
  if (/\bsala\s+(?:comercial|empresarial)|\bloja\b|\bgalp[ãa]o|\bcomercial\b|\bescrit[óo]rio/.test(text)) return 'sala';
  if (/\bcasa\b|\bsobrado|\bres[ií]dencia|\bvilla\b|\bgeminada/.test(text)) return 'casa';
  return 'outro';
}

const PROPERTY_KIND_LABELS: Record<ReturnType<typeof detectPropertyKind>, string> = {
  casa: 'Casas',
  apartamento: 'Apartamentos',
  terreno: 'Terrenos',
  sitio: 'Sítios e chácaras',
  sala: 'Salas comerciais',
  cobertura: 'Coberturas',
  kitnet: 'Kitnets / Studios',
  outro: 'Outros',
};

/**
 * Render order for property-kind sub-groups. We push the most common
 * residential types first (casa → apto), then commercial, then "outro"
 * as a catch-all at the end. Mirrors how a customer skims a real-estate
 * listing.
 */
const PROPERTY_KIND_ORDER: Array<ReturnType<typeof detectPropertyKind>> = [
  'casa',
  'apartamento',
  'cobertura',
  'kitnet',
  'sitio',
  'terreno',
  'sala',
  'outro',
];

/**
 * Build a stable short REF code for a catalog item. Uses the item's
 * existing id when present (preferring the last 6 alphanum chars of a
 * UUID/hash so it's typeable), otherwise hashes the name. Always returns
 * an uppercase 4-7 char code prefixed by "IM-" for visual identity on
 * the card. Reused across PDF renders so the customer can quote the same
 * REF tomorrow and the agent finds the same item.
 */
function buildItemRef(item: CatalogPdfItem, transactionPrefix: string): string {
  const idRaw = (item.id || '').toString();
  const idClean = idRaw.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
  if (idClean.length >= 4) {
    return `${transactionPrefix}-${idClean.slice(-6)}`;
  }
  // Fallback: hash the name for a stable code without an id.
  let h = 0;
  const src = (item.name || '') + '|' + (item.region || '');
  for (let i = 0; i < src.length; i++) h = ((h << 5) - h + src.charCodeAt(i)) | 0;
  const hash = Math.abs(h).toString(36).toUpperCase().slice(0, 5);
  return `${transactionPrefix}-${hash}`;
}

/**
 * Extract origin (https://host) from a URL for display on the cover.
 * Returns the input string when it's already a bare host. Returns null
 * for malformed input so the cover footer can be hidden gracefully.
 */
function deriveSiteUrl(input: CatalogPdfInput): string | null {
  if (input.siteUrl && input.siteUrl.trim()) {
    const s = input.siteUrl.trim();
    return /^https?:\/\//i.test(s) ? s : 'https://' + s;
  }
  for (const it of input.items) {
    const u = (it.url || '').trim();
    if (!u) continue;
    try {
      const parsed = new URL(u);
      return parsed.origin;
    } catch { /* fall through */ }
  }
  return null;
}

/** Fetch an image with a tight timeout + size cap. PDFKit accepts JPEG/PNG
 *  buffers directly so we don't decode — just hand the raw bytes through.
 *  Returns null on any failure so the caller falls back to text-only. */
async function fetchImageBuffer(
  url: string,
  timeoutMs: number,
  maxBytes: number,
): Promise<{ bytes: Buffer; contentType: string } | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: {
        // Some sites hot-link-protect via Referer header; the page-URL
        // referer makes us look like a legitimate viewer, while the UA
        // identifies the source for log auditing.
        'user-agent': 'Mozilla/5.0 (compatible; AxonCatalogPdf/1.0; +https://nexusinovation.com.br)',
        accept: 'image/jpeg,image/png,image/webp,image/*;q=0.8',
      },
    });
    if (!res.ok) return null;
    const ctype = (res.headers.get('content-type') || '').toLowerCase();
    if (!/jpe?g|png/i.test(ctype)) return null;
    const reader = res.body?.getReader();
    if (!reader) {
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.byteLength === 0 || buf.byteLength > maxBytes) return null;
      return { bytes: buf, contentType: ctype };
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
    }
    try { await reader.cancel(); } catch { /* ignore */ }
    if (total === 0) return null;
    const buf = Buffer.alloc(Math.min(total, maxBytes));
    let off = 0;
    for (const c of chunks) {
      const take = Math.min(c.byteLength, buf.length - off);
      buf.set(c.subarray(0, take), off);
      off += take;
      if (off >= buf.length) break;
    }
    return { bytes: buf, contentType: ctype };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Format BRL price for the catalog card. Returns "—" when null/undefined. */
function formatPrice(p: number | null | undefined): string {
  if (typeof p !== 'number' || !isFinite(p)) return '—';
  return 'R$ ' + p.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Pre-fetch all images concurrently with a hard total budget. Returns
 *  a parallel array of buffer-or-null aligned with `items`. Bounded by
 *  concurrency and per-image timeout so a 30-item catalog never adds
 *  more than ~10s to PDF generation. */
async function prefetchItemImages(items: CatalogPdfItem[]): Promise<(Buffer | null)[]> {
  const out: (Buffer | null)[] = new Array(items.length).fill(null);
  const concurrency = 6;
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    await Promise.all(
      batch.map(async (it, j) => {
        const url = (it.image_url || '').trim();
        if (!url || !/^https?:\/\//i.test(url)) return;
        const fetched = await fetchImageBuffer(url, 7_000, 800_000);
        if (fetched) out[i + j] = fetched.bytes;
      }),
    );
  }
  return out;
}

/**
 * Render a multi-page catalog PDF with photos, organized so the customer
 * can browse comparable items together and quote a REF code back to the
 * agent for the listing they want.
 *
 * Layout (rebuilt 2026-05-06 — initial version produced a single mixed
 * grid, customer couldn't reference items, agent couldn't tell which
 * one they meant):
 *   - Cover page: solid accent panel, business name, summary line
 *     ("X imóveis · Y para venda · Z para aluguel"), site URL footer.
 *     The summary tells the customer up front what's inside.
 *   - Section pages: each transaction type (VENDA / ALUGUEL / OUTROS)
 *     gets its own section header page + grid pages. Within a section,
 *     items are sub-grouped by detected property kind (Casas →
 *     Apartamentos → Terrenos → ...) with a small heading between
 *     groups so the customer can skim to what they want.
 *   - Item cards: 2 cards/row × 3 rows = 6 per page. Each card now
 *     prints the REF code prominently in the top-right of the photo
 *     frame, in the accent color, in monospace. Customer can text the
 *     agent "quero saber mais sobre IM-V-A1B2" and the agent looks it
 *     up directly via search_catalog (id match).
 *   - Footer on every page: site URL + page number, so the customer
 *     always knows where to dive deeper.
 *
 * Photos pre-fetched concurrency=6 with 7s per-image timeout. Items that
 * fail to load show a clean "sem foto" placeholder instead of breaking
 * the page.
 */
export async function renderCatalogPdf(input: CatalogPdfInput): Promise<Buffer> {
  const items = input.items.slice(0, 80);  // bumped from 50 — sectioning gives more room
  const photoBuffers = await prefetchItemImages(items);
  const siteUrl = deriveSiteUrl({ ...input, items });

  // ─── Group items: transaction type → property kind ──────────────
  // Stable ordering: venda first (high-value), then aluguel, then "outros"
  // for items without a type set (older catalogs, e-commerce, restaurants).
  type TxnKey = 'venda' | 'aluguel' | 'outros';
  const TXN_ORDER: TxnKey[] = ['venda', 'aluguel', 'outros'];
  const TXN_LABELS: Record<TxnKey, string> = {
    venda: 'Para venda',
    aluguel: 'Para aluguel',
    outros: 'Outros',
  };
  const TXN_PREFIX: Record<TxnKey, string> = {
    venda: 'IM-V',
    aluguel: 'IM-A',
    outros: 'IM',
  };
  const buckets: Record<TxnKey, Array<{ item: CatalogPdfItem; photoIdx: number }>> = {
    venda: [],
    aluguel: [],
    outros: [],
  };
  for (let i = 0; i < items.length; i++) {
    const t = items[i].type;
    const key: TxnKey = t === 'venda' ? 'venda' : t === 'aluguel' ? 'aluguel' : 'outros';
    buckets[key].push({ item: items[i], photoIdx: i });
  }
  // Within each transaction bucket, sub-group by property kind.
  type PropertyKind = ReturnType<typeof detectPropertyKind>;
  type Group = { kind: PropertyKind; entries: Array<{ item: CatalogPdfItem; photoIdx: number; ref: string }> };
  const sections: Array<{ txn: TxnKey; groups: Group[]; total: number }> = [];
  for (const txn of TXN_ORDER) {
    if (buckets[txn].length === 0) continue;
    const byKind = new Map<PropertyKind, Group>();
    for (const e of buckets[txn]) {
      const kind = detectPropertyKind(e.item);
      const ref = buildItemRef(e.item, TXN_PREFIX[txn]);
      const group = byKind.get(kind) || { kind, entries: [] };
      group.entries.push({ item: e.item, photoIdx: e.photoIdx, ref });
      byKind.set(kind, group);
    }
    const groupsOrdered = PROPERTY_KIND_ORDER
      .filter((k) => byKind.has(k))
      .map((k) => byKind.get(k)!);
    sections.push({ txn, groups: groupsOrdered, total: buckets[txn].length });
  }

  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: 'A4',
        margin: PAGE_MARGIN,
        info: {
          Title: `Catálogo — ${input.businessName.slice(0, 100)}`,
          Producer: 'Axon Agent',
          Creator: 'Axon Agent',
        },
        autoFirstPage: false,
        bufferPages: true,
      });
      const chunks: Uint8Array[] = [];
      doc.on('data', (chunk: Uint8Array | Buffer) => {
        chunks.push(chunk instanceof Buffer ? new Uint8Array(chunk) : chunk);
      });
      doc.on('end', () => {
        const total = chunks.reduce((sum, c) => sum + c.length, 0);
        const out = Buffer.alloc(total);
        let offset = 0;
        for (const c of chunks) { out.set(c, offset); offset += c.length; }
        resolve(out);
      });
      doc.on('error', reject);

      doc.addPage();
      const pageW = doc.page.width;
      const pageH = doc.page.height;
      const usableW = pageW - 2 * PAGE_MARGIN;
      const ACCENT = '#7c5cff';

      // ─── Cover page ────────────────────────────────────────
      doc.save();
      doc.rect(0, 0, pageW, pageH).fill(ACCENT);
      doc.restore();

      doc.fillColor('#ffffffcc').font('Helvetica').fontSize(11);
      doc.text('CATÁLOGO', PAGE_MARGIN, PAGE_MARGIN + 8, {
        align: 'center', width: usableW, characterSpacing: 4,
      });

      const nameSize = input.businessName.length > 28 ? 30 : 38;
      doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(nameSize);
      const nameY = pageH / 2 - 100;
      doc.text(input.businessName.slice(0, 100), PAGE_MARGIN, nameY, {
        align: 'center', width: usableW,
      });

      // Summary line — "X imóveis · Y para venda · Z para aluguel"
      const summaryParts: string[] = [];
      summaryParts.push(`${items.length} ite${items.length === 1 ? 'm' : 'ns'}`);
      if (buckets.venda.length) summaryParts.push(`${buckets.venda.length} para venda`);
      if (buckets.aluguel.length) summaryParts.push(`${buckets.aluguel.length} para aluguel`);
      doc.fillColor('#ffffffee').font('Helvetica').fontSize(13);
      doc.text(summaryParts.join(' · '), PAGE_MARGIN, nameY + nameSize + 18, {
        align: 'center', width: usableW,
      });

      // Property-kind breakdown — small chip line so customer sees what's inside
      const kindCounts = new Map<PropertyKind, number>();
      for (const it of items) {
        const k = detectPropertyKind(it);
        kindCounts.set(k, (kindCounts.get(k) || 0) + 1);
      }
      const kindLine = PROPERTY_KIND_ORDER
        .filter((k) => kindCounts.has(k))
        .map((k) => `${kindCounts.get(k)} ${PROPERTY_KIND_LABELS[k].toLowerCase()}`)
        .join(' · ');
      if (kindLine) {
        doc.fillColor('#ffffffaa').font('Helvetica').fontSize(11);
        doc.text(kindLine, PAGE_MARGIN, nameY + nameSize + 44, {
          align: 'center', width: usableW,
        });
      }

      // "Como pedir mais detalhes" — instruction tying the REF system
      // back to the customer's behavior. Tells them HOW to use this PDF.
      doc.fillColor('#ffffffcc').font('Helvetica-Bold').fontSize(11);
      doc.text('Como pedir mais detalhes', PAGE_MARGIN, pageH - PAGE_MARGIN - 130, {
        align: 'center', width: usableW,
      });
      doc.fillColor('#ffffffaa').font('Helvetica').fontSize(10);
      doc.text(
        'Anotou o código no canto superior direito de cada anúncio? Manda o código aqui no WhatsApp (ex: "quero saber mais sobre IM-V-A1B2") que te passo o link direto, fotos e detalhes.',
        PAGE_MARGIN + 24,
        pageH - PAGE_MARGIN - 110,
        { align: 'center', width: usableW - 48, lineGap: 1 },
      );

      // Contact + site URL footer on cover
      const contactLines: string[] = [];
      if (input.businessContact && input.businessContact.trim()) {
        contactLines.push(input.businessContact.trim().slice(0, 200));
      }
      if (siteUrl) contactLines.push(siteUrl);
      if (contactLines.length) {
        doc.fillColor('#ffffffaa').font('Helvetica').fontSize(11);
        doc.text(contactLines.join('   ·   '), PAGE_MARGIN, pageH - PAGE_MARGIN - 50, {
          align: 'center', width: usableW,
        });
      }
      doc.fillColor('#ffffff88').font('Helvetica').fontSize(9);
      doc.text(
        new Date().toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: 'long', year: 'numeric' }),
        PAGE_MARGIN, pageH - PAGE_MARGIN - 28,
        { align: 'center', width: usableW },
      );

      // ─── Item pages: section header + grouped grid ─────────
      const COLS = 2;
      const ROWS = 3;
      const COL_GAP = 16;
      const ROW_GAP = 20;
      const cellW = (usableW - COL_GAP * (COLS - 1)) / COLS;
      const photoBoxH = 140;
      const textBoxH = 130;  // slightly taller — needs room for REF chip on text side too
      const cellH = photoBoxH + textBoxH;
      const cardsPerPage = COLS * ROWS;

      // Cursor management — when a new section/group needs to start and
      // we still have grid slots left on the current page, we just emit
      // a small in-page heading. When we run out of slots, we add a new
      // page. New SECTIONS (txn type) always force a new page so the
      // customer can flip cleanly between "para venda" and "para aluguel".
      let onPage = false;        // are we mid-grid on the current page?
      let slotIdx = 0;            // 0..cardsPerPage-1 within current page
      let gridTop = PAGE_MARGIN + 28;

      const startPage = (sectionLabel: string) => {
        doc.addPage();
        // Section banner — full-width, accent thin band. Customer sees
        // immediately "now I'm in the venda section" or "aluguel".
        doc.save();
        doc.rect(0, PAGE_MARGIN - 24, pageW, 36).fill(ACCENT);
        doc.restore();
        doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(14);
        doc.text(sectionLabel, PAGE_MARGIN, PAGE_MARGIN - 16, {
          width: usableW, align: 'left',
        });
        doc.fillColor('#000000');
        gridTop = PAGE_MARGIN + 28;
        slotIdx = 0;
        onPage = true;
      };

      const drawGroupHeading = (label: string, y: number) => {
        doc.fillColor('#6b7280').font('Helvetica-Bold').fontSize(10);
        doc.text(label.toUpperCase(), PAGE_MARGIN, y, {
          width: usableW, characterSpacing: 2,
        });
        // Thin underline under the heading
        doc.strokeColor('#e2e2e7').lineWidth(0.5)
          .moveTo(PAGE_MARGIN, y + 14).lineTo(pageW - PAGE_MARGIN, y + 14).stroke();
        doc.strokeColor('#000000');
        doc.fillColor('#000000');
      };

      for (const section of sections) {
        const sectionLabel = `${TXN_LABELS[section.txn].toUpperCase()}  ·  ${section.total} ite${section.total === 1 ? 'm' : 'ns'}`;
        startPage(sectionLabel);

        for (const group of section.groups) {
          // Group heading. If the current slot row is mid-page and the
          // group has multiple items, push to a new page so groups don't
          // get split awkwardly. For a 1-item group, fitting is fine.
          if (slotIdx > 0 && (slotIdx % COLS !== 0 || group.entries.length > 1)) {
            // Move to next row + add small heading
            const headingY = gridTop + Math.ceil(slotIdx / COLS) * (cellH + ROW_GAP);
            if (headingY + 80 > pageH - PAGE_MARGIN) {
              startPage(sectionLabel);
            } else {
              drawGroupHeading(`${PROPERTY_KIND_LABELS[group.kind]} (${group.entries.length})`, headingY);
              gridTop = headingY + 22;
              slotIdx = 0;
            }
          } else {
            // First group on a fresh page or aligned slot
            const headingY = gridTop;
            drawGroupHeading(`${PROPERTY_KIND_LABELS[group.kind]} (${group.entries.length})`, headingY);
            gridTop = headingY + 22;
            slotIdx = 0;
          }

          for (const entry of group.entries) {
            if (slotIdx >= cardsPerPage) {
              startPage(sectionLabel);
              drawGroupHeading(`${PROPERTY_KIND_LABELS[group.kind]} (cont.)`, gridTop);
              gridTop = gridTop + 22;
            }
            const col = slotIdx % COLS;
            const row = Math.floor(slotIdx / COLS);
            const cardX = PAGE_MARGIN + col * (cellW + COL_GAP);
            const cardY = gridTop + row * (cellH + ROW_GAP);

            // If the card would overflow the page bottom, flush to new page.
            if (cardY + cellH > pageH - PAGE_MARGIN - 24) {
              startPage(sectionLabel);
              drawGroupHeading(`${PROPERTY_KIND_LABELS[group.kind]} (cont.)`, gridTop);
              gridTop = gridTop + 22;
              continue;  // re-enter loop — slotIdx = 0, will draw at top
            }

            // Card background
            doc.save();
            doc.roundedRect(cardX, cardY, cellW, cellH, 6).fillAndStroke('#ffffff', '#e2e2e7');
            doc.restore();

            // Photo region
            const photoX = cardX + 8;
            const photoY = cardY + 8;
            const photoBoxW = cellW - 16;
            const photoBoxInnerH = photoBoxH - 16;
            doc.save();
            doc.roundedRect(photoX, photoY, photoBoxW, photoBoxInnerH, 4).fillAndStroke('#f3f4f6', '#e2e2e7');
            doc.restore();

            const photoBuf = photoBuffers[entry.photoIdx];
            if (photoBuf) {
              try {
                doc.image(photoBuf, photoX, photoY, {
                  fit: [photoBoxW, photoBoxInnerH],
                  align: 'center',
                  valign: 'center',
                });
              } catch {
                doc.fillColor('#9ca3af').font('Helvetica').fontSize(9);
                doc.text('sem foto', photoX, photoY + photoBoxInnerH / 2 - 5, {
                  width: photoBoxW, align: 'center',
                });
              }
            } else {
              doc.fillColor('#9ca3af').font('Helvetica').fontSize(9);
              doc.text('sem foto', photoX, photoY + photoBoxInnerH / 2 - 5, {
                width: photoBoxW, align: 'center',
              });
            }
            doc.fillColor('#000000');

            // ── REF code chip — top-right, prominent ─────────────
            // The whole point of the layout overhaul: customer can quote
            // this code back. Painted ON TOP of the photo so it stays
            // visually anchored to the card even if the photo is dark.
            const refText = entry.ref;
            doc.font('Helvetica-Bold').fontSize(9);
            const refW = doc.widthOfString(refText) + 12;
            const refX = photoX + photoBoxW - refW - 4;
            const refY = photoY + 4;
            doc.save();
            doc.roundedRect(refX, refY, refW, 16, 3).fill(ACCENT);
            doc.restore();
            doc.fillColor('#ffffff').text(refText, refX, refY + 3, {
              width: refW, align: 'center', characterSpacing: 0.5,
            });
            doc.fillColor('#000000');

            // Text block
            const textX = cardX + 12;
            const textY = cardY + photoBoxH + 4;
            const textW = cellW - 24;
            const it = entry.item;

            doc.font('Helvetica-Bold').fontSize(11).fillColor('#1f2937');
            doc.text((it.name || '').slice(0, 80), textX, textY, {
              width: textW, height: 28, ellipsis: true,
            });

            doc.font('Helvetica-Bold').fontSize(12).fillColor(ACCENT);
            const priceLabel = section.txn === 'aluguel'
              ? `${formatPrice(it.price)}/mês`
              : formatPrice(it.price);
            doc.text(priceLabel, textX, textY + 30, { width: textW });

            let textCursor = textY + 48;
            const region = (it.region || '').trim();
            if (region) {
              doc.font('Helvetica').fontSize(9).fillColor('#6b7280');
              doc.text(region.slice(0, 60), textX, textCursor, {
                width: textW, ellipsis: true,
              });
              textCursor += 14;
            }
            const desc = (it.description || '').trim();
            if (desc) {
              doc.font('Helvetica').fontSize(8.5).fillColor('#4b5563');
              doc.text(desc.slice(0, 200), textX, textCursor, {
                width: textW, height: textY + textBoxH - textCursor - 6,
                ellipsis: true, lineGap: 1,
              });
            }

            slotIdx++;
          }
        }
      }

      // ─── Footer on every non-cover page ────────────────────
      // Site URL on left, page X of Y on right, generation ts on a tiny
      // line under it. Customer always knows where to dive deeper, and
      // the operator can match a printed PDF to its render moment.
      const pageRange = doc.bufferedPageRange?.();
      if (pageRange) {
        const totalPages = pageRange.count;
        const generatedAt = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
        for (let p = pageRange.start + 1; p < pageRange.start + pageRange.count; p++) {
          doc.switchToPage(p);
          const pageNum = p - pageRange.start + 1;
          doc.fillColor('#9ca3af').font('Helvetica').fontSize(9);
          if (siteUrl) {
            doc.text(siteUrl, PAGE_MARGIN, pageH - PAGE_MARGIN - 20, {
              width: usableW / 2, align: 'left',
            });
          }
          doc.text(
            `Página ${pageNum} de ${totalPages}`,
            PAGE_MARGIN + usableW / 2, pageH - PAGE_MARGIN - 20,
            { width: usableW / 2, align: 'right' },
          );
          doc.fillColor('#cccccc').fontSize(8);
          doc.text(generatedAt, PAGE_MARGIN, pageH - PAGE_MARGIN - 6, {
            width: usableW, align: 'center',
          });
        }
        doc.fillColor('#000000');
      }

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

// ───────────────────────────────────────────────────────────────────
// Brochure PDF — single-listing sophistication.
//
// Used by the send_brochure_pdf tool when a customer wants the deep
// dive on one specific item ("manda a brochura desse apartamento",
// "preciso ver os detalhes desse imóvel", "panfleto desse aqui"). The
// layout mirrors what real-estate launch brochures look like (Cyrela /
// MRV / Tegra style) so the customer perceives the listing as serious
// and the platform as polished.
//
// Pages:
//   1. Cover — full-bleed cover photo, gradient overlay, big name +
//      price + REF + status pill (lançamento / pronto / construção).
//   2. Specs — tipologia chips (quartos, área, vagas, suítes), big
//      description block.
//   3. Lazer/amenidades — chip grid + a short tagline.
//   4. Sobre o bairro — neighborhood_info text + region tag.
//   5. Plantas (only if item has plantas[]) — up to 3 floor plans.
//   6. Galeria — full grid of remaining photos.
//   7. Contato/back-cover — accent panel + business + URL + REF.
//
// Sections without data SKIP entirely — owner with bare-bones catalog
// gets a 3-page brochure (cover + galeria + contato) instead of a
// padded one with empty sections.
// ───────────────────────────────────────────────────────────────────

export interface BrochurePdfInput {
  item: CatalogPdfItem & {
    tipologia?: string;
    area_m2?: number;
    vagas?: number;
    suites?: number;
    amenidades?: string[];
    status_obra?: 'pronto' | 'construcao' | 'lancamento' | 'usado' | null;
    neighborhood_info?: string;
    plantas?: string[];
  };
  /** REF code shown on the cover and on every page footer. Caller
   *  builds it (whatsapp/runtime) so the same code in the PDF matches
   *  what the customer sees in the catalog PDF. */
  ref?: string;
  /** Owner-side context for cover + back-cover. */
  businessName: string;
  businessContact?: string;
  siteUrl?: string;
}

const STATUS_LABELS: Record<NonNullable<NonNullable<BrochurePdfInput['item']['status_obra']>>, { label: string; color: string }> = {
  lancamento: { label: 'LANÇAMENTO', color: '#16a34a' },
  construcao: { label: 'EM CONSTRUÇÃO', color: '#f59e0b' },
  pronto: { label: 'PRONTO PRA MORAR', color: '#0ea5e9' },
  usado: { label: 'IMÓVEL USADO', color: '#6366f1' },
};

/** Fetch + decode an image — reuses fetchImageBuffer from above. Returns
 *  Buffer or null. Used both for cover and for gallery shots. */
async function fetchSingleImage(url: string | undefined | null): Promise<Buffer | null> {
  if (!url || !/^https?:\/\//i.test(url)) return null;
  const r = await fetchImageBuffer(url, 7_000, 1_500_000);
  return r ? r.bytes : null;
}

export async function renderBrochurePdf(input: BrochurePdfInput): Promise<Buffer> {
  const { item } = input;
  const allImages = Array.from(new Set([
    ...(item.image_url ? [item.image_url] : []),
    ...(item.images || []),
  ]));
  const coverUrl = item.image_url || allImages[0] || null;
  const galleryUrls = allImages.filter((u) => u !== coverUrl).slice(0, 8);
  const [coverBuf, plantaBufs, galleryBufs] = await Promise.all([
    fetchSingleImage(coverUrl),
    Promise.all((item.plantas || []).slice(0, 3).map(fetchSingleImage)),
    Promise.all(galleryUrls.map(fetchSingleImage)),
  ]);

  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: 'A4',
        margin: PAGE_MARGIN,
        info: {
          Title: item.name.slice(0, 100),
          Producer: 'Axon Agent',
          Creator: 'Axon Agent',
        },
        autoFirstPage: false,
        bufferPages: true,
      });
      const chunks: Uint8Array[] = [];
      doc.on('data', (chunk: Uint8Array | Buffer) => {
        chunks.push(chunk instanceof Buffer ? new Uint8Array(chunk) : chunk);
      });
      doc.on('end', () => {
        const total = chunks.reduce((sum, c) => sum + c.length, 0);
        const out = Buffer.alloc(total);
        let offset = 0;
        for (const c of chunks) { out.set(c, offset); offset += c.length; }
        resolve(out);
      });
      doc.on('error', reject);

      const ACCENT = '#7c5cff';

      doc.addPage();
      const pageW = doc.page.width;
      const pageH = doc.page.height;
      const usableW = pageW - 2 * PAGE_MARGIN;

      // ─── 1. COVER PAGE (full-bleed image, gradient, big text) ───
      if (coverBuf) {
        try {
          doc.image(coverBuf, 0, 0, { cover: [pageW, pageH] });
        } catch {
          doc.save().rect(0, 0, pageW, pageH).fill(ACCENT).restore();
        }
      } else {
        doc.save().rect(0, 0, pageW, pageH).fill(ACCENT).restore();
      }
      const overlayHeight = pageH * 0.55;
      const overlayTop = pageH - overlayHeight;
      doc.save();
      const bands = 14;
      for (let i = 0; i < bands; i++) {
        const alpha = 0.05 + (i / bands) * 0.55;
        doc.opacity(alpha).rect(0, overlayTop + (overlayHeight / bands) * i, pageW, overlayHeight / bands + 1).fill('#000000');
      }
      doc.opacity(1);
      doc.restore();

      if (item.status_obra && STATUS_LABELS[item.status_obra]) {
        const meta = STATUS_LABELS[item.status_obra];
        doc.font('Helvetica-Bold').fontSize(9);
        const labelW = doc.widthOfString(meta.label) + 18;
        doc.save();
        doc.roundedRect(PAGE_MARGIN, PAGE_MARGIN, labelW, 22, 4).fill(meta.color);
        doc.restore();
        doc.fillColor('#ffffff').text(meta.label, PAGE_MARGIN, PAGE_MARGIN + 6, {
          width: labelW, align: 'center', characterSpacing: 1.5,
        });
        doc.fillColor('#000000');
      }

      if (input.ref) {
        doc.font('Helvetica-Bold').fontSize(10);
        const refW = doc.widthOfString(input.ref) + 16;
        const refX = pageW - PAGE_MARGIN - refW;
        doc.save();
        doc.roundedRect(refX, PAGE_MARGIN, refW, 22, 4).fill(ACCENT);
        doc.restore();
        doc.fillColor('#ffffff').text(input.ref, refX, PAGE_MARGIN + 6, {
          width: refW, align: 'center',
        });
        doc.fillColor('#000000');
      }

      const titleY = pageH - 200;
      doc.fillColor('#ffffff').font('Helvetica-Bold');
      const nameSize = item.name.length > 40 ? 22 : item.name.length > 25 ? 28 : 32;
      doc.fontSize(nameSize);
      doc.text(item.name, PAGE_MARGIN, titleY, {
        width: usableW, align: 'left',
      });

      if (item.region) {
        doc.font('Helvetica').fontSize(13).fillColor('#ffffffcc');
        doc.text(item.region, PAGE_MARGIN, titleY + nameSize + 8, {
          width: usableW, align: 'left',
        });
      }

      const priceLabel = item.type === 'aluguel'
        ? `${formatPrice(item.price)}/mês`
        : formatPrice(item.price);
      doc.fillColor(ACCENT).font('Helvetica-Bold').fontSize(26);
      doc.text(priceLabel, PAGE_MARGIN, pageH - 90, {
        width: usableW, align: 'left',
      });

      doc.fillColor('#ffffffaa').font('Helvetica').fontSize(9);
      doc.text(input.businessName, PAGE_MARGIN, pageH - 30, {
        width: usableW, align: 'right',
      });

      // ─── 2. SPECS PAGE ────────────────────────────────────────────
      const hasSpecs = item.tipologia || item.area_m2 || item.vagas || item.suites || item.description;
      if (hasSpecs) {
        doc.addPage();
        doc.fillColor('#1f2937').font('Helvetica-Bold').fontSize(20);
        doc.text('Sobre o imóvel', PAGE_MARGIN, PAGE_MARGIN, { width: usableW });
        doc.strokeColor(ACCENT).lineWidth(2)
          .moveTo(PAGE_MARGIN, PAGE_MARGIN + 28).lineTo(PAGE_MARGIN + 60, PAGE_MARGIN + 28).stroke();

        const specs: Array<{ label: string; value: string }> = [];
        if (item.tipologia) specs.push({ label: 'Tipologia', value: item.tipologia });
        if (item.area_m2) specs.push({ label: 'Área útil', value: `${item.area_m2} m²` });
        if (typeof item.vagas === 'number') specs.push({ label: 'Vagas', value: String(item.vagas) });
        if (typeof item.suites === 'number') specs.push({ label: 'Suítes', value: String(item.suites) });

        if (specs.length) {
          const cols = Math.min(specs.length, 4);
          const chipW = (usableW - 16 * (cols - 1)) / cols;
          const chipH = 80;
          const chipsTop = PAGE_MARGIN + 50;
          for (let i = 0; i < specs.length && i < cols; i++) {
            const x = PAGE_MARGIN + i * (chipW + 16);
            doc.save();
            doc.roundedRect(x, chipsTop, chipW, chipH, 8).fillAndStroke('#f9fafb', '#e2e2e7');
            doc.restore();
            doc.fillColor('#6b7280').font('Helvetica').fontSize(9);
            doc.text(specs[i].label.toUpperCase(), x + 12, chipsTop + 12, {
              width: chipW - 24, characterSpacing: 1.5,
            });
            doc.fillColor('#1f2937').font('Helvetica-Bold').fontSize(20);
            doc.text(specs[i].value, x + 12, chipsTop + 32, { width: chipW - 24, ellipsis: true });
          }
          doc.fillColor('#000000');
        }

        const descTop = PAGE_MARGIN + 50 + (specs.length ? 100 : 0);
        if (item.description) {
          doc.fillColor('#374151').font('Helvetica').fontSize(11);
          doc.text(item.description, PAGE_MARGIN, descTop, {
            width: usableW, lineGap: 4, align: 'left',
          });
        }
      }

      // ─── 3. LAZER ────────────────────────────────────────────────
      if (item.amenidades && item.amenidades.length > 0) {
        doc.addPage();
        doc.fillColor('#1f2937').font('Helvetica-Bold').fontSize(20);
        doc.text('Lazer e infraestrutura', PAGE_MARGIN, PAGE_MARGIN, { width: usableW });
        doc.strokeColor(ACCENT).lineWidth(2)
          .moveTo(PAGE_MARGIN, PAGE_MARGIN + 28).lineTo(PAGE_MARGIN + 60, PAGE_MARGIN + 28).stroke();
        doc.fillColor('#6b7280').font('Helvetica').fontSize(11);
        doc.text('Tudo que tá disponível no condomínio / unidade.', PAGE_MARGIN, PAGE_MARGIN + 42, { width: usableW });

        const amns = item.amenidades.slice(0, 12);
        const cols = 3;
        const colW = (usableW - 16 * (cols - 1)) / cols;
        const rowH = 38;
        const startY = PAGE_MARGIN + 80;
        for (let i = 0; i < amns.length; i++) {
          const col = i % cols;
          const row = Math.floor(i / cols);
          const x = PAGE_MARGIN + col * (colW + 16);
          const y = startY + row * (rowH + 12);
          doc.save();
          doc.roundedRect(x, y, colW, rowH, rowH / 2).fillAndStroke('#f3f4f6', '#e2e2e7');
          doc.restore();
          doc.save().fillColor(ACCENT).circle(x + 18, y + rowH / 2, 4).fill().restore();
          doc.fillColor('#1f2937').font('Helvetica').fontSize(10);
          doc.text(amns[i].slice(0, 50), x + 30, y + rowH / 2 - 6, {
            width: colW - 36, ellipsis: true,
          });
        }
        doc.fillColor('#000000');
      }

      // ─── 4. SOBRE O BAIRRO ────────────────────────────────────────
      if (item.neighborhood_info || item.region) {
        doc.addPage();
        doc.fillColor('#1f2937').font('Helvetica-Bold').fontSize(20);
        doc.text('Sobre o bairro', PAGE_MARGIN, PAGE_MARGIN, { width: usableW });
        doc.strokeColor(ACCENT).lineWidth(2)
          .moveTo(PAGE_MARGIN, PAGE_MARGIN + 28).lineTo(PAGE_MARGIN + 60, PAGE_MARGIN + 28).stroke();
        if (item.region) {
          doc.fillColor(ACCENT).font('Helvetica-Bold').fontSize(13);
          doc.text(item.region, PAGE_MARGIN, PAGE_MARGIN + 42, { width: usableW });
        }
        if (item.neighborhood_info) {
          doc.fillColor('#374151').font('Helvetica').fontSize(11);
          doc.text(item.neighborhood_info, PAGE_MARGIN, PAGE_MARGIN + 70, {
            width: usableW, lineGap: 4, align: 'left',
          });
        } else {
          doc.fillColor('#6b7280').font('Helvetica-Oblique').fontSize(10);
          doc.text(
            'Pra mais detalhes sobre escolas, mercados, transporte e distância da praia, fale com a gente — temos a info atualizada da região.',
            PAGE_MARGIN, PAGE_MARGIN + 70,
            { width: usableW, lineGap: 4 },
          );
        }
      }

      // ─── 5. PLANTAS ────────────────────────────────────────────────
      const validPlantaBufs = plantaBufs.filter((b): b is Buffer => !!b);
      if (validPlantaBufs.length > 0) {
        doc.addPage();
        doc.fillColor('#1f2937').font('Helvetica-Bold').fontSize(20);
        doc.text('Plantas', PAGE_MARGIN, PAGE_MARGIN, { width: usableW });
        doc.strokeColor(ACCENT).lineWidth(2)
          .moveTo(PAGE_MARGIN, PAGE_MARGIN + 28).lineTo(PAGE_MARGIN + 60, PAGE_MARGIN + 28).stroke();
        const plantaH = (pageH - PAGE_MARGIN * 2 - 60) / Math.min(validPlantaBufs.length, 3);
        for (let i = 0; i < validPlantaBufs.length && i < 3; i++) {
          try {
            doc.image(validPlantaBufs[i], PAGE_MARGIN, PAGE_MARGIN + 50 + i * plantaH, {
              fit: [usableW, plantaH - 10],
              align: 'center', valign: 'center',
            });
          } catch { /* ignore corrupt */ }
        }
      }

      // ─── 6. GALERIA ────────────────────────────────────────────────
      const validGallery = galleryBufs.filter((b): b is Buffer => !!b);
      if (validGallery.length > 0) {
        doc.addPage();
        doc.fillColor('#1f2937').font('Helvetica-Bold').fontSize(20);
        doc.text('Galeria', PAGE_MARGIN, PAGE_MARGIN, { width: usableW });
        doc.strokeColor(ACCENT).lineWidth(2)
          .moveTo(PAGE_MARGIN, PAGE_MARGIN + 28).lineTo(PAGE_MARGIN + 60, PAGE_MARGIN + 28).stroke();
        const cols = 2;
        const gap = 12;
        const cellW = (usableW - gap * (cols - 1)) / cols;
        const cellH = (pageH - PAGE_MARGIN * 2 - 60) / 3 - gap;
        for (let i = 0; i < validGallery.length && i < 6; i++) {
          const col = i % cols;
          const row = Math.floor(i / cols);
          const x = PAGE_MARGIN + col * (cellW + gap);
          const y = PAGE_MARGIN + 50 + row * (cellH + gap);
          doc.save();
          doc.roundedRect(x, y, cellW, cellH, 4).fillAndStroke('#f3f4f6', '#e2e2e7');
          doc.restore();
          try {
            doc.image(validGallery[i], x, y, {
              fit: [cellW, cellH], align: 'center', valign: 'center',
            });
          } catch { /* ignore */ }
        }
      }

      // ─── 7. CONTATO / BACK COVER ──────────────────────────────────
      doc.addPage();
      doc.save();
      doc.rect(0, 0, pageW, pageH).fill(ACCENT);
      doc.restore();
      doc.fillColor('#ffffffcc').font('Helvetica').fontSize(11);
      doc.text('FALE COM A GENTE', PAGE_MARGIN, pageH / 2 - 80, {
        width: usableW, align: 'center', characterSpacing: 4,
      });
      doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(28);
      doc.text(input.businessName, PAGE_MARGIN, pageH / 2 - 50, {
        width: usableW, align: 'center',
      });
      const contactLines: string[] = [];
      if (input.businessContact) contactLines.push(input.businessContact);
      if (input.siteUrl) contactLines.push(input.siteUrl);
      if (item.url && item.url !== input.siteUrl) contactLines.push(item.url);
      doc.fillColor('#ffffffee').font('Helvetica').fontSize(13);
      doc.text(contactLines.join('\n'), PAGE_MARGIN, pageH / 2 + 10, {
        width: usableW, align: 'center', lineGap: 6,
      });
      doc.fillColor('#ffffff88').font('Helvetica').fontSize(9);
      if (input.ref) {
        doc.text(`REF ${input.ref}`, PAGE_MARGIN, pageH - PAGE_MARGIN - 30, {
          width: usableW, align: 'center',
        });
      }
      doc.text(
        new Date().toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: 'long', year: 'numeric' }),
        PAGE_MARGIN, pageH - PAGE_MARGIN - 14,
        { width: usableW, align: 'center' },
      );

      // ─── Footer on every interior page (not cover, not back cover) ─
      const pageRange = doc.bufferedPageRange?.();
      if (pageRange && pageRange.count > 2) {
        const totalPages = pageRange.count;
        for (let p = pageRange.start + 1; p < pageRange.start + pageRange.count - 1; p++) {
          doc.switchToPage(p);
          doc.fillColor('#9ca3af').font('Helvetica').fontSize(8);
          doc.text(input.businessName.slice(0, 60), PAGE_MARGIN, pageH - PAGE_MARGIN - 14, {
            width: usableW / 2, align: 'left',
          });
          doc.text(
            input.ref ? `${input.ref}  ·  ${p - pageRange.start + 1}/${totalPages}` : `${p - pageRange.start + 1}/${totalPages}`,
            PAGE_MARGIN + usableW / 2, pageH - PAGE_MARGIN - 14,
            { width: usableW / 2, align: 'right' },
          );
        }
        doc.fillColor('#000000');
      }

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

// ───────────────────────────────────────────────────────────────────
// Filtered-subset PDF — "seleção pra você".
//
// Used when the customer asks for a curated cut ("manda em PDF as
// casas até 500k em Tabatinga"). Reuses renderCatalogPdf's section
// machinery; the cover label swap puts "Seleção · <descrição>" in the
// big-text spot instead of the generic business name.
// ───────────────────────────────────────────────────────────────────

export interface FilteredPdfInput extends CatalogPdfInput {
  /** Description of what the cut means — appears on the cover so the
   *  customer remembers WHY this list was sent. e.g. "Casas até R$
   *  500k em Tabatinga". Caller composes this from the search query. */
  selectionLabel: string;
  /** Optional personal note from the agent — shown in italic on the
   *  cover. e.g. "Olá Mariana, separei essas pensando no que você
   *  falou — qualquer dúvida me chama." */
  personalNote?: string;
}

export async function renderFilteredPdf(input: FilteredPdfInput): Promise<Buffer> {
  // Cap a curated cut at 8 — beyond that it stops feeling "selecionado"
  // and becomes a small catalog. Owners can always send the full one
  // via send_catalog_pdf instead.
  const items = input.items.slice(0, 8);
  if (items.length === 0) {
    return renderPdf({
      title: input.selectionLabel,
      body:
        'Não encontrei itens dentro desse filtro no momento. Posso te avisar assim que entrar algo novo, ' +
        'ou ajustar a busca pra outro bairro / faixa de preço — me chama no chat que a gente combina.',
      businessName: input.businessName,
    });
  }
  const compositeContact = input.businessContact
    ? `${input.businessName}   ·   ${input.businessContact}`
    : input.businessName;
  return renderCatalogPdf({
    businessName: `Seleção · ${input.selectionLabel.slice(0, 80)}`,
    businessContact: input.personalNote
      ? `${input.personalNote.slice(0, 200)}\n${compositeContact}`
      : compositeContact,
    siteUrl: input.siteUrl,
    items,
  });
}
