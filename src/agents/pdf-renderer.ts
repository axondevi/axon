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
