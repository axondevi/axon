#!/usr/bin/env node
/**
 * build-pdf.js — Converte axon-academy-master.md em PDF profissional
 *
 * Pipeline:
 *   1. Lê markdown + CSS
 *   2. Converte markdown → HTML com marked (zero deps pra parse)
 *   3. Embute no template HTML com capa + TOC + conteúdo
 *   4. Chama Chrome headless pra print-to-PDF
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MD_PATH = resolve(__dirname, 'axon-academy-master.md');
const CSS_PATH = resolve(__dirname, 'style.css');
const HTML_PATH = resolve(__dirname, 'axon-academy-master.html');
const PDF_PATH = resolve(__dirname, 'axon-academy-master.pdf');

// ─── Markdown → HTML conversion (minimal, hand-rolled) ──────────────────
function mdToHtml(md) {
  const lines = md.split('\n');
  let html = '';
  let inCode = false;
  let codeLang = '';
  let codeBuffer = [];
  let inList = false;
  let listType = null;
  let inTable = false;
  let tableRows = [];
  let inBlockquote = false;
  let bqBuffer = [];
  let paragraph = [];

  const flushParagraph = () => {
    if (paragraph.length) {
      html += `<p>${inlineFormat(paragraph.join(' '))}</p>\n`;
      paragraph = [];
    }
  };

  const flushList = () => {
    if (inList) {
      html += `</${listType}>\n`;
      inList = false;
      listType = null;
    }
  };

  const flushTable = () => {
    if (inTable && tableRows.length) {
      html += '<table>\n';
      const headerRow = tableRows[0];
      html += '<thead><tr>';
      for (const cell of headerRow) html += `<th>${inlineFormat(cell)}</th>`;
      html += '</tr></thead>\n<tbody>\n';
      for (let i = 2; i < tableRows.length; i++) {
        html += '<tr>';
        for (const cell of tableRows[i]) html += `<td>${inlineFormat(cell)}</td>`;
        html += '</tr>\n';
      }
      html += '</tbody></table>\n';
      inTable = false;
      tableRows = [];
    }
  };

  const flushBlockquote = () => {
    if (inBlockquote) {
      html += `<blockquote>${inlineFormat(bqBuffer.join(' '))}</blockquote>\n`;
      inBlockquote = false;
      bqBuffer = [];
    }
  };

  const flushAll = () => {
    flushParagraph();
    flushList();
    flushTable();
    flushBlockquote();
  };

  function inlineFormat(text) {
    let t = text;
    // Escape HTML first — but preserve already-safe content
    t = t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    // Inline code
    t = t.replace(/`([^`]+)`/g, '<code>$1</code>');
    // Bold
    t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    // Italic
    t = t.replace(/(?<![*])\*([^*\n]+)\*(?![*])/g, '<em>$1</em>');
    // Links [text](url)
    t = t.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
    return t;
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Code fence
    if (line.startsWith('```')) {
      if (!inCode) {
        flushAll();
        inCode = true;
        codeLang = line.slice(3).trim();
        codeBuffer = [];
      } else {
        const escaped = codeBuffer
          .join('\n')
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;');
        html += `<pre><code class="language-${codeLang}">${escaped}</code></pre>\n`;
        inCode = false;
        codeLang = '';
      }
      continue;
    }
    if (inCode) { codeBuffer.push(line); continue; }

    // Horizontal rule
    if (/^---+$/.test(line.trim())) {
      flushAll();
      html += '<hr>\n';
      continue;
    }

    // Headings
    const hMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (hMatch) {
      flushAll();
      const level = hMatch[1].length;
      html += `<h${level}>${inlineFormat(hMatch[2])}</h${level}>\n`;
      continue;
    }

    // Blockquote
    if (line.startsWith('> ')) {
      flushParagraph(); flushList(); flushTable();
      if (!inBlockquote) inBlockquote = true;
      bqBuffer.push(line.slice(2));
      continue;
    } else if (inBlockquote && line.trim() === '') {
      flushBlockquote();
    }

    // Table (pipe-based)
    if (line.includes('|') && line.trim().startsWith('|')) {
      flushParagraph(); flushList(); flushBlockquote();
      const cells = line.split('|').slice(1, -1).map(s => s.trim());
      if (!inTable) inTable = true;
      // Skip separator row |---|---|
      if (!cells.every(c => /^:?-+:?$/.test(c))) {
        tableRows.push(cells);
      } else {
        tableRows.push('separator');
      }
      continue;
    } else if (inTable && line.trim() === '') {
      flushTable();
    }

    // Lists
    const ulMatch = line.match(/^(\s*)[-*]\s+(.+)$/);
    const olMatch = line.match(/^(\s*)\d+\.\s+(.+)$/);
    if (ulMatch || olMatch) {
      flushParagraph(); flushBlockquote(); flushTable();
      const m = ulMatch || olMatch;
      const newType = ulMatch ? 'ul' : 'ol';
      if (!inList) {
        html += `<${newType}>\n`;
        inList = true;
        listType = newType;
      } else if (listType !== newType) {
        html += `</${listType}>\n<${newType}>\n`;
        listType = newType;
      }
      html += `<li>${inlineFormat(m[2])}</li>\n`;
      continue;
    } else if (inList && line.trim() === '') {
      flushList();
    }

    // Empty line
    if (line.trim() === '') {
      flushParagraph();
      continue;
    }

    // Regular paragraph
    paragraph.push(line);
  }
  flushAll();

  return html;
}

// ─── Build HTML document ────────────────────────────────────────────────
function buildHtml(bodyHtml, css) {
  const coverHtml = `
    <div class="cover">
      <div class="cover-header">
        <div class="cover-logo">AXON ACADEMY</div>
        <div class="cover-eyebrow">Documento Mestre · v1.0</div>
      </div>
      <div class="cover-body">
        <h1 class="cover-title">Estratégia, Arquitetura e Plano de Execução</h1>
        <p class="cover-subtitle">
          Plataforma de aprendizado sobre agentes de IA<br/>
          como motor de aquisição, ativo de marca e ferramenta de comunidade.
        </p>
      </div>
      <div class="cover-footer">
        <div class="cover-meta">
          <p><strong>Autor:</strong> Planejamento conjunto com o operador do Axon</p>
          <p><strong>Publicado:</strong> 24 de abril de 2026</p>
          <p><strong>Projeto:</strong> axon-5zf.pages.dev</p>
        </div>
        <div class="cover-meta" style="text-align: right;">
          <p><strong>12 Partes</strong></p>
          <p><strong>10 Pillars detalhados</strong></p>
          <p><strong>5 Apêndices</strong></p>
        </div>
      </div>
    </div>
  `;

  // Table of Contents (static, mirrors the doc structure)
  const tocHtml = `
    <div class="toc-page">
      <h1 class="toc-title" style="page-break-before: avoid; border-top: none; margin-top: 0;">Sumário</h1>
      <ul class="toc-list">
        <li><strong>Prefácio — Como usar este documento</strong><br><span>Legendas, como ler, por onde começar</span></li>
        <li><strong>Parte 1 — Visão estratégica</strong><br><span>Por que Academy, posicionamento, 3 nichos a dominar</span></li>
        <li><strong>Parte 2 — SEO 101: aula rápida</strong><br><span>Intent, pillar vs cluster, PT-BR como ouro enterrado</span></li>
        <li><strong>Parte 3 — Arquitetura do site</strong><br><span>Estrutura /learn, tipos de conteúdo, jornada de personas</span></li>
        <li><strong>Parte 4 — Os 10 artigos-pilar destrinchados</strong><br><span>Query-alvo, outline, CTA e clusters de cada pillar</span></li>
        <li><strong>Parte 5 — Design & UX</strong><br><span>Princípios visuais, tipografia, componentes, wireframe</span></li>
        <li><strong>Parte 6 — Stack técnica</strong><br><span>Astro, MDX, Pagefind, Giscus, Cloudflare Pages</span></li>
        <li><strong>Parte 7 — Plano de execução</strong><br><span>Semana 1 MVP, mês 1, meses 2-6</span></li>
        <li><strong>Parte 8 — Community & Marketing</strong><br><span>Newsletter, Giscus, submit-a-tutorial, cross-pollination</span></li>
        <li><strong>Parte 9 — Métricas & KPIs</strong><br><span>Fases, vanity vs real, funil Academy → paying user</span></li>
        <li><strong>Parte 10 — Como você contribui</strong><br><span>Seu papel crítico, rotina semanal, ferramentas</span></li>
        <li><strong>Parte 11 — Decisões pendentes</strong><br><span>5 perguntas que preciso da sua resposta</span></li>
        <li><strong>Parte 12 — Apêndices</strong><br><span>Glossário, links, templates, checklists</span></li>
      </ul>
    </div>
  `;

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <title>Axon Academy — Documento Mestre</title>
  <style>${css}</style>
</head>
<body>
  ${coverHtml}
  ${tocHtml}
  <div class="content">
    ${bodyHtml}
  </div>
</body>
</html>`;
}

// ─── Main ────────────────────────────────────────────────────────────────
console.log('[1/4] Reading files...');
const md = readFileSync(MD_PATH, 'utf-8');
const css = readFileSync(CSS_PATH, 'utf-8');

// Strip the first H1 from markdown (already in cover) and the sumário list
let cleanedMd = md;
cleanedMd = cleanedMd.replace(/^# Axon Academy[\s\S]*?(?=^## Prefácio)/m, '');

console.log('[2/4] Converting markdown to HTML...');
const bodyHtml = mdToHtml(cleanedMd);

console.log('[3/4] Assembling HTML document...');
const fullHtml = buildHtml(bodyHtml, css);
writeFileSync(HTML_PATH, fullHtml, 'utf-8');
console.log(`      → ${HTML_PATH}`);

console.log('[4/4] Generating PDF via Chrome headless...');
const chromePaths = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
];
const chromePath = chromePaths.find(p => existsSync(p));
if (!chromePath) {
  console.error('Chrome not found at expected paths.');
  process.exit(1);
}

const fileUrl = 'file:///' + HTML_PATH.replace(/\\/g, '/');
const cmd = `"${chromePath}" --headless=new --disable-gpu --no-sandbox --print-to-pdf="${PDF_PATH}" --no-pdf-header-footer --virtual-time-budget=5000 "${fileUrl}"`;

try {
  execSync(cmd, { stdio: 'inherit' });
  console.log(`\n✓ PDF generated: ${PDF_PATH}`);
} catch (err) {
  console.error('PDF generation failed:', err.message);
  process.exit(1);
}
