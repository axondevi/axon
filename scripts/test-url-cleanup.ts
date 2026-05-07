/**
 * Smoke test for the post-strip cleanup logic — replays the exact
 * production failure mode where stripping a hallucinated URL left
 * "Link com mais detalhes: " + "br/" orphans behind.
 */
function cleanup(reply: string, hallucinatedUrls: string[]): string {
  let cleaned = reply;
  for (const u of hallucinatedUrls) {
    cleaned = cleaned.split(u).join('');
  }
  const isLinkPromiseSentence = /\b(?:link\b|site\b|url\b|acesse\b|veja\s+(?:em|aqui|aí|abaixo)|olha\s+(?:o|a)\s+(?:an[úu]ncio|im[óo]vel|link)|confira\s+em|saiba\s+mais\s+em|clica\s+(?:em|no\s+link|aqui)|an[úu]ncio\s+(?:aqui|aí))\b/i;
  const isMostlyHostFragment = (s: string): boolean => {
    const stripped = s.replace(/[\s.,;:\-—!?]+/g, '');
    if (stripped.length < 5) return false;
    return /^(?:www\.)?[a-z0-9-]+(?:\.[a-z]{2,})+(?:\/\S*)?\/?$/i.test(s.trim());
  };
  const sentences = cleaned.split(/(?<=[.!?])\s+/);
  const kept: string[] = [];
  for (const raw of sentences) {
    const s = raw.trim();
    if (!s) continue;
    const stripped = s
      .replace(/\b(?:link|site|url|acesse|veja|confira|olha|an[úu]ncio)\s*(?:com|de|do|da|para|aqui|abaixo|aí|o|a)?\s*(?:mais\s+)?(?:informa[çc][ãa]o(?:es)?|detalhes?|info|pre[çc]o|valor|do\s+(?:an[úu]ncio|im[óo]vel)|completo)?\s*[:\-—]?\s*/gi, '')
      .replace(/[\s.,;:\-—]+/g, '')
      .trim();
    if (isLinkPromiseSentence.test(s) && stripped.length < 4) continue;
    if (/^(?:[a-z]{2,4}\/?\s*)$/i.test(s)) continue;
    if (isMostlyHostFragment(s)) continue;
    kept.push(s);
  }
  cleaned = kept.join(' ').replace(/\s{2,}/g, ' ').trim();
  cleaned = cleaned
    .replace(/\b(?:link\s+(?:com\s+mais\s+(?:informa[çc][ãa]o(?:es)?|detalhes?|info)|do\s+an[úu]ncio|do\s+im[óo]vel|completo|aqui|abaixo)|veja\s+em|acesse|saiba\s+mais\s+em|confira\s+em)\s*[:\-—]?\s*(?:[.,]\s*)?(?=$|[A-ZÁÉÍÓÚÂÊÔÃÕÇ]|\n)/gim, '')
    .replace(/\s+(?:com|com\.br|net|org|br)\/+\s*$/gi, '')
    .replace(/\s+(?:com|com\.br|net|org|br)\/+\s+/gi, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return cleaned;
}

interface Case { input: string; urls: string[]; mustNotContain: string[]; mustContain?: string[]; label: string; }

const cases: Case[] = [
  {
    label: 'production case 5217 reply',
    input: 'O imóvel IM-A-LDJK6X é um sobrado em condomínio fechado no bairro Tabatinga, em Caraguatatuba. R$ 15.000,00. Link com mais detalhes: https://www.imobiliariachagas.com.br/imoveis/IM-A-LDJK6X. Posso agendar uma visita para você conhecer o imóvel?',
    urls: ['https://www.imobiliariachagas.com.br/imoveis/IM-A-LDJK6X'],
    mustNotContain: ['Link com mais detalhes:', 'Link com mais detalhes: .', 'br/', 'imoveis/IM-A-LDJK6X'],
    mustContain: ['R$ 15.000,00', 'agendar uma visita'],
  },
  {
    label: 'orphan TLD fragment after strip',
    input: 'Olha o anúncio aqui: https://chagas.com.br/casa-X. Posso te ajudar mais? www.chagas.com.br/',
    urls: ['https://chagas.com.br/casa-X'],
    mustNotContain: ['Olha o anúncio aqui:', 'www.chagas.com.br/'],
  },
  {
    label: 'simple URL strip — sentence kept',
    input: 'Recebido. Veja em https://chagas.com.br/foo. Boa tarde.',
    urls: ['https://chagas.com.br/foo'],
    mustNotContain: ['Veja em'],
    mustContain: ['Recebido', 'Boa tarde'],
  },
  {
    label: 'real URL kept, only hallucinated stripped',
    input: 'Aqui está o link real: https://real.com/x. E o falso: https://fake.com/y.',
    urls: ['https://fake.com/y'],
    mustContain: ['https://real.com/x'],
    mustNotContain: ['fake.com'],
  },
];

let pass = 0; let fail = 0;
for (const c of cases) {
  const out = cleanup(c.input, c.urls);
  const violations: string[] = [];
  for (const m of c.mustNotContain) if (out.includes(m)) violations.push(`leftover: "${m}"`);
  for (const m of c.mustContain || []) if (!out.includes(m)) violations.push(`missing: "${m}"`);
  const ok = violations.length === 0;
  if (ok) pass++; else fail++;
  console.log(`${ok ? '✅' : '❌'} ${c.label}`);
  console.log(`   in:  ${JSON.stringify(c.input.slice(0, 100))}…`);
  console.log(`   out: ${JSON.stringify(out)}`);
  if (violations.length) console.log(`   ⚠ ${violations.join(' · ')}`);
  console.log();
}
console.log(`${pass}/${pass + fail} passed`);
