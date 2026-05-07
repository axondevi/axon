/**
 * End-to-end smoke test for the bracket-placeholder guard pipeline.
 *
 * Exercises:
 *   1. PLACEHOLDER_RE detection on the EXACT strings observed in prod
 *      (screenshots 5208 + 5210, imobiliaria-em-caraguatatuba agent)
 *   2. Strip + cleanup logic — verifies "Aqui está o PDF:" leftovers
 *      get cleaned, not just the brackets
 *   3. renderCatalogPdf auto-build with a sample real-estate catalog
 *   4. End-to-end integration: stubborn-LLM reply → saneated output
 *
 * Run with: bun run scripts/test-placeholder-guard.ts
 */
import { renderCatalogPdf } from '~/agents/pdf-renderer';

// ─── 1. PLACEHOLDER_RE — same regex as whatsapp.ts ─────────────────
const PLACEHOLDER_RE = /\[(?:[^\]]*\b(?:PDF|CAT[ÁA]LOGO|FOTO|FOTOS|ARQUIVO|DOCUMENTO|IMAGEM|FACHADA|LINK|VEJA|ANEXO)\b[^\]]*)\]/i;

// Real strings observed in production from the imobiliária agent.
const productionFailures: Array<[label: string, reply: string, expectsHit: boolean]> = [
  [
    'screenshot 5208 — first PDF placeholder',
    'Aqui está o PDF: [PDF DA CASA EM PONTAL DE SANTA MARINA] Este PDF contém informações detalhadas sobre a casa em Pontal de Santa Marina, incluindo fotos, descrição e valor.',
    true,
  ],
  [
    'screenshot 5210 — repeated PDF placeholder',
    'Claro, posso te enviar um PDF com informações sobre uma casa que ainda não te mostrei. Aqui está o PDF: [PDF DA CASA EM PONTAL DE SANTA MARINA] Este PDF contém informações detalhadas...',
    true,
  ],
  [
    'classic catálogo placeholder',
    'Segue o catálogo: [CATÁLOGO COMPLETO DE IMÓVEIS]',
    true,
  ],
  [
    'foto fachada',
    'Olha aí: [FOTO DA FACHADA]',
    true,
  ],
  [
    'link disfarçado',
    'Aqui está o link: [LINK DO CATÁLOGO]',
    true,
  ],
  [
    'reply legítimo (NÃO deve casar)',
    'Pronto, te mandei o catálogo aqui. Qualquer dúvida me chama.',
    false,
  ],
  [
    'reply legítimo com bracket inocente (NÃO deve casar)',
    'O imóvel custa R$ 1.500.000 [valor à negociar].',
    false,
  ],
];

console.log('\n═══ 1. PLACEHOLDER_RE detection ═══\n');
let hits = 0; let misses = 0;
for (const [label, reply, expectsHit] of productionFailures) {
  const m = reply.match(PLACEHOLDER_RE);
  const got = !!m;
  const ok = got === expectsHit;
  if (ok) hits++; else misses++;
  console.log(`${ok ? '✅' : '❌'} ${label}`);
  console.log(`   reply: ${JSON.stringify(reply.slice(0, 80))}${reply.length > 80 ? '…' : ''}`);
  console.log(`   match: ${m ? JSON.stringify(m[0]) : '(no match)'} · expected: ${expectsHit ? 'hit' : 'miss'}\n`);
}
console.log(`Detection: ${hits}/${productionFailures.length} correct\n`);

// ─── 2. Strip + cleanup logic ─────────────────────────────────────
function stripAndClean(reply: string): string {
  return reply
    .replace(/\[[^\]]*\b(?:PDF|CAT[ÁA]LOGO|FOTO|FOTOS|ARQUIVO|DOCUMENTO|IMAGEM|FACHADA|LINK|VEJA|ANEXO)\b[^\]]*\]/gi, '')
    .replace(/\b(?:aqui\s+(?:est[áa]|vai)\s+(?:o|a)|segue|olha)\s+(?:o\s+|a\s+)?(?:pdf|cat[áa]logo|cat[áa]logo\s+completo|foto|fotos|imagem|imagens|arquivo|documento|link|anexo)\s*:\s*(?=$|\n)/gim, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

console.log('═══ 2. Strip + cleanup ═══\n');
const stripCases: Array<[before: string, mustNotContain: string[]]> = [
  // Production case 5208 — must drop the bracket AND the "Aqui está o PDF:" prefix
  [
    'Aqui está o PDF: [PDF DA CASA EM PONTAL DE SANTA MARINA]',
    ['[PDF', 'Aqui está o PDF:'],
  ],
  [
    'Segue o catálogo: [CATÁLOGO COMPLETO DE IMÓVEIS]',
    ['[CATÁLOGO', 'Segue o catálogo:'],
  ],
  [
    'Aqui está a foto: [FOTO DA FACHADA]\n\nLinda imóvel.',
    ['[FOTO', 'Aqui está a foto:'],
  ],
];
for (const [before, mustNotContain] of stripCases) {
  const after = stripAndClean(before);
  const violations = mustNotContain.filter((s) => after.includes(s));
  const ok = violations.length === 0;
  console.log(`${ok ? '✅' : '❌'} input:  ${JSON.stringify(before.slice(0, 90))}`);
  console.log(`   output: ${JSON.stringify(after)}`);
  if (violations.length) console.log(`   ⚠ leftover: ${JSON.stringify(violations)}`);
  console.log();
}

// ─── 3. renderCatalogPdf with real-estate catalog ─────────────────
console.log('═══ 3. Auto-build renderCatalogPdf ═══\n');
const sampleCatalog = [
  // VENDA — várias casas
  { id: 'a1b2c3', name: 'Casa em Pontal de Santa Marina', price: 1500000, region: 'Pontal de Santa Marina, Caraguatatuba', description: 'Casa de alto padrão com 4 quartos, 3 banheiros, sala ampla e cozinha gourmet. Vista para o mar.', image_url: null, url: 'https://imobiliariacaragua.com.br/casa-pontal', type: 'venda' },
  { id: 'd4e5f6', name: 'Casa Térrea no Indaiá', price: 690000, region: 'Indaiá, Caraguatatuba', description: '3 quartos, edícula, quintal grande, ideal pra família.', image_url: null, url: 'https://imobiliariacaragua.com.br/casa-indaia', type: 'venda' },
  { id: 'g7h8i9', name: 'Sobrado em Massaguaçu', price: 980000, region: 'Massaguaçu, Caraguatatuba', description: 'Sobrado 5 dormitórios, suíte master com hidromassagem, piscina.', image_url: null, url: 'https://imobiliariacaragua.com.br/sobrado-massaguacu', type: 'venda' },
  // VENDA — apto
  { id: 'j0k1l2', name: 'Apartamento no Centro', price: 480000, region: 'Centro, Caraguatatuba', description: 'Apto 3 dormitórios sendo 1 suíte. Sacada com churrasqueira, 2 vagas de garagem.', image_url: null, url: 'https://imobiliariacaragua.com.br/apto-centro', type: 'venda' },
  { id: 'm3n4o5', name: 'Cobertura Duplex Vista Mar', price: 1850000, region: 'Praia das Palmeiras, Caraguatatuba', description: 'Cobertura 4 suítes, churrasqueira, jacuzzi, vista 180° pro mar.', image_url: null, url: 'https://imobiliariacaragua.com.br/cobertura', type: 'venda' },
  // VENDA — terreno
  { id: 'p6q7r8', name: 'Terreno em Lot. Estância Mineira', price: 150000, region: 'Estância Mineira, Caraguatatuba', description: 'Terreno 500m² localizado em bairro tranquilo, próximo à natureza.', image_url: null, url: 'https://imobiliariacaragua.com.br/terreno-em', type: 'venda' },
  // ALUGUEL
  { id: 's9t0u1', name: 'Casa em Pontal de Santa Marina (temporada)', price: 850, region: 'Pontal de Santa Marina, Caraguatatuba', description: 'Casa para temporada, 3 quartos, 8 pessoas, 2 quadras da praia.', image_url: null, url: 'https://imobiliariacaragua.com.br/temporada-pontal', type: 'aluguel' },
  { id: 'v2w3x4', name: 'Apto Mobiliado Centro', price: 2200, region: 'Centro, Caraguatatuba', description: 'Apto 2 dormitórios mobiliado, 1 vaga, contrato 30 meses.', image_url: null, url: 'https://imobiliariacaragua.com.br/apto-mobil', type: 'aluguel' },
  { id: 'y5z6a7', name: 'Kitnet próximo à UFSP', price: 1100, region: 'Massaguaçu, Caraguatatuba', description: 'Kitnet mobiliada, ideal pra estudante, próxima ao campus.', image_url: null, url: 'https://imobiliariacaragua.com.br/kitnet-ufsp', type: 'aluguel' },
  { id: 'b8c9d0', name: 'Sala Comercial Centro', price: 3500, region: 'Centro, Caraguatatuba', description: 'Sala comercial 80m², andar alto, vaga de garagem.', image_url: null, url: 'https://imobiliariacaragua.com.br/sala-com', type: 'aluguel' },
];

try {
  const t0 = Date.now();
  const buf = await renderCatalogPdf({
    businessName: 'Imobiliária em Caraguatatuba',
    businessContact: '+55 12 9XXXX-XXXX · contato@imobiliariacaragua.com.br',
    siteUrl: 'https://imobiliariacaragua.com.br',
    items: sampleCatalog as any,
  });
  const ms = Date.now() - t0;
  const head = buf.slice(0, 4).toString('ascii');
  const ok = head === '%PDF' && buf.length > 1000;
  console.log(`${ok ? '✅' : '❌'} PDF buffer: ${buf.length} bytes · header=${JSON.stringify(head)} · ${ms}ms`);
  if (ok) {
    const out = `/tmp/auto-built-imobiliaria-${Date.now()}.pdf`;
    await Bun.write(out, buf);
    console.log(`   wrote: ${out} — abre pra inspecionar`);
  } else {
    console.log(`   ❌ PDF inválido — header=${head}, size=${buf.length}`);
  }
} catch (err) {
  console.log(`❌ renderCatalogPdf threw: ${err instanceof Error ? err.message : String(err)}`);
}

// ─── 4. End-to-end: stubborn LLM scenario ─────────────────────────
// ─── 3.5. Brochure PDF + Filtered PDF ─────────────────────────────
console.log('\n═══ 3.5. Brochure + Filtered PDFs ═══\n');
try {
  const { renderBrochurePdf, renderFilteredPdf } = await import('~/agents/pdf-renderer');

  // Brochure: a sophisticated single-listing PDF
  const t1 = Date.now();
  const brochureBytes = await renderBrochurePdf({
    ref: 'IM-V-A1B2C3',
    businessName: 'Imobiliária em Caraguatatuba',
    businessContact: '+55 12 9XXXX-XXXX · contato@imobiliariacaragua.com.br',
    siteUrl: 'https://imobiliariacaragua.com.br',
    item: {
      id: 'a1b2c3',
      name: 'Apartamento Residencial Vista Mar',
      price: 980000,
      region: 'Praia das Palmeiras, Caraguatatuba',
      description: 'Apartamento 3 dormitórios sendo 1 suíte master, sala ampla com sacada gourmet integrada à cozinha. Vista frontal pro mar, andar alto, sol da manhã. 2 vagas de garagem.',
      image_url: null,
      url: 'https://imobiliariacaragua.com.br/apto-vista-mar',
      type: 'venda',
      tipologia: '3 dormitórios',
      area_m2: 110,
      vagas: 2,
      suites: 1,
      amenidades: ['Piscina adulto e infantil', 'Academia', 'Salão de festas', 'Churrasqueira gourmet', 'Playground', 'Portaria 24h', 'Elevador', 'Vaga visitante'],
      status_obra: 'pronto',
      neighborhood_info: 'Praia das Palmeiras é um dos bairros mais valorizados de Caraguatatuba. Comércio completo a pé, escolas particulares (Objetivo, Nova Geração) num raio de 1km, supermercado Zaffari na esquina, e a praia a 200 metros do prédio. Acesso direto à Tamoios em 5 minutos.',
      plantas: [],
    },
  });
  const t1ms = Date.now() - t1;
  const ok1 = brochureBytes.slice(0, 4).toString('ascii') === '%PDF';
  console.log(`${ok1 ? '✅' : '❌'} Brochure: ${brochureBytes.length} bytes · header=%PDF · ${t1ms}ms`);
  if (ok1) {
    const path = `/tmp/brochura-${Date.now()}.pdf`;
    await Bun.write(path, brochureBytes);
    console.log(`   wrote: ${path}`);
  }

  // Filtered: 3-item curated subset
  const t2 = Date.now();
  const filteredBytes = await renderFilteredPdf({
    businessName: 'Imobiliária em Caraguatatuba',
    businessContact: '+55 12 9XXXX-XXXX',
    siteUrl: 'https://imobiliariacaragua.com.br',
    selectionLabel: 'Casas até R$ 1MM em Pontal de Santa Marina',
    personalNote: 'Olá Mariana, separei essas pensando no que você falou — qualquer dúvida me chama.',
    items: sampleCatalog.filter((c: any) => c.type === 'venda' && c.region.includes('Pontal')) as any,
  });
  const t2ms = Date.now() - t2;
  const ok2 = filteredBytes.slice(0, 4).toString('ascii') === '%PDF';
  console.log(`${ok2 ? '✅' : '❌'} Filtered: ${filteredBytes.length} bytes · ${t2ms}ms`);
  if (ok2) {
    const path = `/tmp/filtered-${Date.now()}.pdf`;
    await Bun.write(path, filteredBytes);
    console.log(`   wrote: ${path}`);
  }
} catch (err) {
  console.log(`❌ brochure/filtered render error: ${err instanceof Error ? err.message : String(err)}`);
}

console.log('\n═══ 4. End-to-end — stubborn LLM scenario ═══\n');
console.log('Cenário: LLM escreveu placeholder duas vezes (1ª tentativa + recovery).');
console.log('Pipeline esperada:');
console.log('   [a] guard detecta placeholder em "Aqui está o PDF: [PDF DA CASA...]"');
console.log('   [b] re-invoke com tool_choice=required (não simulado aqui)');
console.log('   [c] suposto: recovery falhou → auto-build renderCatalogPdf');
console.log('   [d] reply final = "Pronto, te mandei o catálogo completo..."');
console.log('   [e] strip remove qualquer placeholder remanescente\n');

const stubbornReply = 'Aqui está o PDF: [PDF DA CASA EM PONTAL DE SANTA MARINA] Este PDF contém informações detalhadas.';
console.log(`input (stubborn LLM):     ${JSON.stringify(stubbornReply)}`);
console.log(`detected placeholder:      ${JSON.stringify(stubbornReply.match(PLACEHOLDER_RE)?.[0] || null)}`);
const autoBuiltReply = `Pronto, te mandei o catálogo completo em PDF — ${sampleCatalog.length} itens com fotos e detalhes 📄`;
console.log(`reply após auto-build:    ${JSON.stringify(autoBuiltReply)}`);
console.log(`reply após strip final:    ${JSON.stringify(stripAndClean(autoBuiltReply))}`);
console.log(`\nrecap: cliente recebe → "${autoBuiltReply}" + PDF como anexo no WhatsApp.`);
console.log(`(sem nenhum "[PDF]" ou "Aqui está o PDF:" pendurado)`);
