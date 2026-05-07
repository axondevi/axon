/**
 * Smoke test for the descriptor-mismatch guard. Replays the production
 * 5217 failure: agent said "sobrado em condomínio fechado" when the
 * actual item is a commercial property.
 */

interface Case {
  reply: string;
  searchExcerpt: string;
  mustBeRewritten: boolean;
  mustNotContain?: string[];
  mustContain?: string[];
  label: string;
}

function applyGuard(reply: string, searchExcerpts: string): { reply: string; mismatched: string[] } {
  searchExcerpts = searchExcerpts.toLowerCase();
  if (searchExcerpts.length === 0) return { reply, mismatched: [] };
  const DESCRIPTORS = [
    'condom[íi]nio\\s+fechado',
    'sala\\s+comercial',
    'galp[ãa]o',
    'cobertura',
    'duplex',
    'triplex',
    'kitnet',
    'studio',
    'st[úu]dio',
    'sobrado',
    'apartamento',
    'apto',
    'terreno',
    'lote',
    's[íi]tio',
    'ch[áa]cara',
    'fazenda',
    'flat',
    'comercial',
    'casa(?:\\s+t[ée]rrea)?',
  ];
  const mismatched: string[] = [];
  let cleaned = reply;
  for (const pat of DESCRIPTORS) {
    const re = new RegExp(`\\b${pat}\\b`, 'iu');
    if (re.test(reply.toLowerCase()) && !re.test(searchExcerpts)) {
      mismatched.push(pat);
      const reReplace = new RegExp(`\\b${pat}\\b`, 'giu');
      cleaned = cleaned.replace(reReplace, 'imóvel');
    }
  }
  if (mismatched.length > 0) {
    let prev = '';
    while (prev !== cleaned) {
      prev = cleaned;
      cleaned = cleaned
        .replace(/\bim[óo]vel\s+(?:em|de|do|da)\s+im[óo]vel\b/gi, 'imóvel')
        .replace(/\bim[óo]vel\s+im[óo]vel\b/gi, 'imóvel')
        .replace(/\bim[óo]vel\s+em\s+condom[íi]nio\s+fechado\b/gi, 'imóvel')
        .replace(/\s{2,}/g, ' ')
        .trim();
    }
    if (!/confirmando|confirmar|verificando/i.test(cleaned)) {
      cleaned = cleaned.replace(/[.?!]?\s*$/, '. Tô confirmando os detalhes exatos com a equipe.');
    }
  }
  return { reply: cleaned, mismatched };
}

const cases: Case[] = [
  {
    label: 'production case 5217 — sobrado vs commercial',
    reply: 'O imóvel IM-A-LDJK6X é um sobrado em condomínio fechado no bairro Tabatinga, em Caraguatatuba.',
    searchExcerpt: '{"items":[{"id":"a1b2c3d4ldjk6x","name":"Imóvel comercial Tabatinga","description":"Imóvel comercial em Caraguatatuba","type":"aluguel"}]}',
    mustBeRewritten: true,
    mustNotContain: ['sobrado', 'condomínio fechado', 'imóvel em imóvel', 'imóvel imóvel'],
    mustContain: ['confirmando'],
  },
  {
    label: 'legit case — item is sobrado, agent says sobrado',
    reply: 'É um lindo sobrado de 4 quartos em Tabatinga.',
    searchExcerpt: '{"items":[{"name":"Sobrado 4 quartos Tabatinga","description":"Sobrado de alto padrão"}]}',
    mustBeRewritten: false,
    mustContain: ['sobrado'],
  },
  {
    label: 'no search performed — no rewrite',
    reply: 'É um sobrado de 4 quartos.',
    searchExcerpt: '',
    mustBeRewritten: false,
    mustContain: ['sobrado'],
  },
  {
    label: 'casa hallucinated when item is apartamento',
    reply: 'Recebi sua dúvida! Essa casa fica em Centro, com 3 quartos.',
    searchExcerpt: '{"items":[{"name":"Apartamento 3 quartos Centro","description":"Apto no Centro"}]}',
    mustBeRewritten: true,
    mustNotContain: ['casa'],
  },
];

let pass = 0; let fail = 0;
for (const c of cases) {
  const result = applyGuard(c.reply, c.searchExcerpt);
  const wasRewritten = result.mismatched.length > 0;
  const violations: string[] = [];
  if (wasRewritten !== c.mustBeRewritten) {
    violations.push(`expected rewritten=${c.mustBeRewritten}, got ${wasRewritten}`);
  }
  for (const m of c.mustNotContain || []) {
    if (result.reply.toLowerCase().includes(m.toLowerCase())) {
      violations.push(`leftover: "${m}"`);
    }
  }
  for (const m of c.mustContain || []) {
    if (!result.reply.toLowerCase().includes(m.toLowerCase())) {
      violations.push(`missing: "${m}"`);
    }
  }
  const ok = violations.length === 0;
  if (ok) pass++; else fail++;
  console.log(`${ok ? '✅' : '❌'} ${c.label}`);
  console.log(`   in:  ${JSON.stringify(c.reply.slice(0, 100))}`);
  console.log(`   out: ${JSON.stringify(result.reply)}`);
  console.log(`   mismatched: [${result.mismatched.join(', ')}]`);
  if (violations.length) console.log(`   ⚠ ${violations.join(' · ')}`);
  console.log();
}
console.log(`${pass}/${pass + fail} passed`);
