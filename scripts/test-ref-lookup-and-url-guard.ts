/**
 * Smoke test for the case 5217 fixes:
 *   1. searchCatalog matches REF codes ("IM-A-LDJK6X") by id-last-6
 *   2. Anti-hallucinated-URL detection (in-process replay of guard logic)
 */
import { searchCatalog, type CatalogItem } from '~/agents/catalog';

console.log('═══ 1. searchCatalog REF lookup ═══\n');

const catalog: CatalogItem[] = [
  { id: 'a1b2c3d4ldjk6x', name: 'Sobrado Tabatinga 4 quartos', region: 'Tabatinga, Caraguatatuba', url: 'https://imobiliariachagas.com.br/sobrado-tabatinga-id-9871', type: 'aluguel' as const },
  { id: 'xx99ldjk6y', name: 'Casa praia Massaguaçu', region: 'Massaguaçu', url: 'https://imobiliariachagas.com.br/casa-praia-id-5523', type: 'venda' as const },
  { id: 'zz77abcdef', name: 'Apto Centro 2 quartos', region: 'Centro, Caraguatatuba', url: 'https://imobiliariachagas.com.br/apto-centro-id-2210', type: 'aluguel' as const },
];

const cases: Array<[query: string, expectedFirstId: string | null, label: string]> = [
  ['IM-A-LDJK6X', 'a1b2c3d4ldjk6x', 'REF code (production case 5217)'],
  ['IM-V-LDJK6Y', 'xx99ldjk6y', 'REF code with V prefix'],
  ['IM-ABCDEF', 'zz77abcdef', 'REF code without V/A prefix'],
  ['Tabatinga', 'a1b2c3d4ldjk6x', 'fallback name search'],
  ['IM-X-NOMATCH', null, 'unknown REF — falls through, returns 0'],
];

let pass = 0; let fail = 0;
for (const [query, expectedFirstId, label] of cases) {
  const results = searchCatalog(catalog, query, 5);
  const firstId = results.length > 0 ? results[0].id : null;
  const ok = firstId === expectedFirstId;
  if (ok) pass++; else fail++;
  console.log(`${ok ? '✅' : '❌'} ${label}: query=${JSON.stringify(query)} → firstId=${firstId} (expected ${expectedFirstId})`);
}
console.log(`\n${pass}/${pass + fail} passed`);

// ─── 2. URL hallucination detection (replay logic) ────────────────
console.log('\n═══ 2. URL hallucination detection ═══\n');

interface FakeToolCall {
  name: string;
  args: Record<string, unknown>;
  ok: boolean;
  response_excerpt?: string;
}

function isHallucinated(reply: string, toolCalls: FakeToolCall[], businessInfo: string, catalog: CatalogItem[]): string[] {
  const cleanUrl = (u: string) => u.replace(/[.,;:!?]+$/, '');
  const urlsInReply = (reply.match(/https?:\/\/[^\s)<>"'`,]+/g) || []).map(cleanUrl);
  if (urlsInReply.length === 0) return [];
  const grounded = new Set<string>();
  for (const t of toolCalls) {
    const exc = (t.response_excerpt || '') + ' ' + JSON.stringify(t.args || {});
    const ms = exc.match(/https?:\/\/[^\s)<>"'`,]+/g);
    if (ms) for (const m of ms) grounded.add(cleanUrl(m));
  }
  const businessUrls = businessInfo.match(/https?:\/\/[^\s)<>"'`,]+/g) || [];
  for (const u of businessUrls) grounded.add(cleanUrl(u));
  for (const it of catalog) if (it.url) grounded.add(cleanUrl(it.url));
  const groundedHosts = new Set<string>();
  for (const u of grounded) {
    try { groundedHosts.add(new URL(u).host.toLowerCase()); } catch { /* ignore */ }
  }
  const hallucinated: string[] = [];
  for (const replyUrl of urlsInReply) {
    if (grounded.has(replyUrl)) continue;
    let host: string | null = null;
    try { host = new URL(replyUrl).host.toLowerCase(); } catch { /* invalid */ }
    if (host && groundedHosts.has(host) && !grounded.has(replyUrl)) {
      hallucinated.push(replyUrl);
    } else if (!host || !groundedHosts.has(host)) {
      hallucinated.push(replyUrl);
    }
  }
  return hallucinated;
}

const businessInfo = 'Imobiliária Chagas - Caraguatatuba\nSite: https://imobiliariachagas.com.br';

const urlCases: Array<[reply: string, calls: FakeToolCall[], expectedHallucinated: number, label: string]> = [
  [
    'Aqui está o link do imóvel: https://imobiliariachagas.com.br/imoveis/IM-A-LDJK6X. Posso agendar visita?',
    [{ name: 'search_catalog', args: { query: 'IM-A-LDJK6X' }, ok: true, response_excerpt: '{"items":[{"id":"a1b2c3d4ldjk6x","name":"Sobrado","url":"https://imobiliariachagas.com.br/sobrado-tabatinga-id-9871"}]}' }],
    1,
    'production case 5217 (LLM constructed URL)',
  ],
  [
    'Aqui está o link do imóvel: https://imobiliariachagas.com.br/sobrado-tabatinga-id-9871. Posso agendar visita?',
    [{ name: 'search_catalog', args: { query: 'IM-A-LDJK6X' }, ok: true, response_excerpt: '{"items":[{"id":"a1b2c3d4ldjk6x","name":"Sobrado","url":"https://imobiliariachagas.com.br/sobrado-tabatinga-id-9871"}]}' }],
    0,
    'real URL from tool — NO false positive',
  ],
  [
    'Visite nosso site: https://imobiliariachagas.com.br',
    [],
    0,
    'business_info URL — NO false positive',
  ],
  [
    'Aqui está: https://random-fake-site.com/abc/xyz',
    [],
    1,
    'completely fake URL — caught',
  ],
];

let urlPass = 0; let urlFail = 0;
for (const [reply, calls, expectedCount, label] of urlCases) {
  const hits = isHallucinated(reply, calls, businessInfo, catalog);
  const ok = hits.length === expectedCount;
  if (ok) urlPass++; else urlFail++;
  console.log(`${ok ? '✅' : '❌'} ${label}: hallucinated=${hits.length} (expected ${expectedCount}) ${hits.length ? `[${hits.join(', ')}]` : ''}`);
}
console.log(`\n${urlPass}/${urlPass + urlFail} passed`);
