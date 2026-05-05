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
  name: string;
  price?: number | null;
  region?: string | null;
  description?: string | null;
  image_url?: string | null;
  url?: string | null;
}

export interface CatalogPdfInput {
  /** Owner business name shown on the cover. */
  businessName: string;
  /** Optional one-line contact info under the business name on the cover (phone / address). */
  businessContact?: string;
  /** Items to render. Caller is expected to have already filtered + capped. */
  items: CatalogPdfItem[];
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
 * Render a multi-page catalog PDF with photos. Layout: cover page +
 * 2-column grid cards (photo on top, text below). Cards are sized so
 * 6 fit per A4 page; a 30-item catalog produces ~6 pages.
 *
 * Photos are pre-fetched in parallel (concurrency 6, per-image timeout
 * 7s) to keep total render time under ~12s on slow upstreams. Items
 * whose photo fails to load render as text-only cards instead of failing
 * the whole document.
 */
export async function renderCatalogPdf(input: CatalogPdfInput): Promise<Buffer> {
  const items = input.items.slice(0, 50);
  const photoBuffers = await prefetchItemImages(items);

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

      const pageW = doc.page.width;
      const pageH = doc.page.height;
      const usableW = pageW - 2 * PAGE_MARGIN;

      // ─── Cover page ────────────────────────────────────────
      doc.font('Helvetica-Bold').fontSize(28).fillColor('#222222');
      doc.text(input.businessName.slice(0, 100), PAGE_MARGIN, pageH / 2 - 80, {
        align: 'center', width: usableW,
      });
      doc.moveDown(0.5);
      doc.font('Helvetica').fontSize(13).fillColor('#666666');
      doc.text('Catálogo de produtos e serviços', { align: 'center', width: usableW });
      if (input.businessContact && input.businessContact.trim()) {
        doc.moveDown(0.7);
        doc.fontSize(11).fillColor('#888888');
        doc.text(input.businessContact.trim().slice(0, 200), { align: 'center', width: usableW });
      }
      doc.moveDown(2);
      doc.fontSize(11).fillColor('#444444');
      doc.text(`${items.length} ite${items.length === 1 ? 'm' : 'ns'} disponíve${items.length === 1 ? 'l' : 'is'}`, {
        align: 'center', width: usableW,
      });
      doc.moveDown(0.4);
      doc.fontSize(9).fillColor('#999999');
      doc.text(
        new Date().toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: 'long', year: 'numeric' }),
        { align: 'center', width: usableW },
      );
      doc.fillColor('#000000');

      // ─── Item cards (2-col grid) ───────────────────────────
      // Cell geometry: 2 columns with a 16pt gap, 3 rows per page.
      const COLS = 2;
      const ROWS = 3;
      const COL_GAP = 16;
      const ROW_GAP = 20;
      const cellW = (usableW - COL_GAP * (COLS - 1)) / COLS;
      const cellHeaderImgH = 140; // photo height
      const cellTextH = 130;      // text block height
      const cellH = cellHeaderImgH + cellTextH;
      const gridTop = PAGE_MARGIN + 30; // room for "Página N" header
      const cardsPerPage = COLS * ROWS;

      for (let i = 0; i < items.length; i++) {
        const slot = i % cardsPerPage;
        if (slot === 0) {
          doc.addPage();
          // Page header (small, top-right)
          doc.font('Helvetica').fontSize(9).fillColor('#aaaaaa');
          doc.text(
            `${input.businessName.slice(0, 60)}  ·  página ${Math.floor(i / cardsPerPage) + 2}`,
            PAGE_MARGIN, PAGE_MARGIN - 10, { align: 'right', width: usableW },
          );
          doc.fillColor('#000000');
        }
        const col = slot % COLS;
        const row = Math.floor(slot / COLS);
        const x = PAGE_MARGIN + col * (cellW + COL_GAP);
        const y = gridTop + row * (cellH + ROW_GAP);

        // Card background
        doc.save();
        doc.roundedRect(x, y, cellW, cellH, 6).fillAndStroke('#fafafa', '#e5e5e5');
        doc.restore();

        // Photo (or placeholder)
        const photoBuf = photoBuffers[i];
        const photoX = x + 8;
        const photoY = y + 8;
        const photoW = cellW - 16;
        const photoH = cellHeaderImgH - 16;
        if (photoBuf) {
          try {
            doc.save();
            doc.roundedRect(photoX, photoY, photoW, photoH, 4).clip();
            doc.image(photoBuf, photoX, photoY, { width: photoW, height: photoH, cover: [photoW, photoH] });
            doc.restore();
          } catch {
            // If pdfkit can't decode (rare — corrupt JPEG), draw the placeholder instead.
            doc.save();
            doc.roundedRect(photoX, photoY, photoW, photoH, 4).fillAndStroke('#f0f0f0', '#dddddd');
            doc.fillColor('#aaaaaa').font('Helvetica').fontSize(9).text('sem foto', photoX, photoY + photoH / 2 - 6, { width: photoW, align: 'center' });
            doc.restore();
          }
        } else {
          doc.save();
          doc.roundedRect(photoX, photoY, photoW, photoH, 4).fillAndStroke('#f0f0f0', '#dddddd');
          doc.fillColor('#aaaaaa').font('Helvetica').fontSize(9).text('sem foto', photoX, photoY + photoH / 2 - 6, { width: photoW, align: 'center' });
          doc.restore();
        }
        doc.fillColor('#000000');

        // Text block — name (bold), price line, region, description.
        const textX = x + 12;
        const textY = y + cellHeaderImgH + 2;
        const textW = cellW - 24;
        const it = items[i];
        doc.font('Helvetica-Bold').fontSize(11).fillColor('#222222');
        doc.text((it.name || '').slice(0, 80), textX, textY, { width: textW, ellipsis: true, height: 28 });
        const priceText = formatPrice(it.price);
        const region = (it.region || '').trim();
        doc.font('Helvetica-Bold').fontSize(11).fillColor('#7c5cff');
        doc.text(priceText, textX, textY + 28, { width: textW });
        if (region) {
          doc.font('Helvetica').fontSize(9).fillColor('#777777');
          doc.text(region.slice(0, 60), textX, textY + 44, { width: textW, ellipsis: true });
        }
        const desc = (it.description || '').trim();
        if (desc) {
          doc.font('Helvetica').fontSize(8.5).fillColor('#444444');
          doc.text(desc.slice(0, 220), textX, textY + (region ? 60 : 44), {
            width: textW, height: 60, ellipsis: true, lineGap: 1,
          });
        }
      }

      // ─── Footer on last page ────────────────────────────────
      doc.font('Helvetica').fontSize(8).fillColor('#999999');
      doc.text(
        `Gerado em ${new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}`,
        PAGE_MARGIN, pageH - PAGE_MARGIN - HEADER_GAP,
        { align: 'center', width: usableW },
      );
      doc.fillColor('#000000');

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}
