/**
 * Smoke test for the PDF-claim regex (case 5215).
 * Validates that the lying-text detector catches the actual production
 * failure mode while not false-firing on questions / refusals / offers.
 */
// `\b` in JS regex is ASCII-only even with the `u` flag — `está\b`
// fails because á is not a \w char. Drop the trailing \b; the leading
// \b is fine (these all start with ASCII) and the noun regex elsewhere
// provides the second-half context. Trailing space/punct/EOL is implicit.
const PDF_CLAIM_INTRO = /\b(?:aqui\s+(?:est[áa]|vai)|te\s+mandei|te\s+mando|segue(?:\s+(?:em\s+anexo|aí|abaixo|aqui))?|olha\s+(?:o|a|aí|aqui)|j[áa]\s+te\s+(?:mandei|enviei)|enviei\s+(?:o|a)?)/i;
const PDF_CLAIM_NOUN = /\b(?:cat[áa]logo|pdf|arquivo|documento|brochura|panfleto|sele[çc][ãa]o|comprovante|recibo|ficha|receita|orienta[çc][ãa]o|contrato|atestado|laudo|or[çc]amento|termo)\b/i;

const cases: Array<[reply: string, expected: boolean, label: string]> = [
  ['Olá, aqui está o catálogo completo em PDF — 21 itens com fotos e detalhes 📄', true, 'screenshot 5215'],
  ['Pronto, te mandei o catálogo completo aqui 📄', true, 'natural delivery claim'],
  ['Segue o catálogo abaixo 📎', true, 'short delivery'],
  ['Já te enviei a brochura', true, 'past delivery claim'],
  ['Você quer o PDF do catálogo?', false, 'question, not claim'],
  ['Não posso te enviar PDF aqui', false, 'refusal'],
  ['Posso te mandar o catálogo em PDF se quiser', false, 'offer, not claim'],
  ['Olá, tudo bem? Como posso te ajudar?', false, 'greeting'],
  ['O imóvel custa R$ 1.500.000 e fica em Caraguatatuba', false, 'pure info'],
];

let pass = 0; let fail = 0;
for (const [reply, expected, label] of cases) {
  const sentences = reply.split(/[.!?\n]+/);
  let hit = false;
  let evidence = '';
  for (const s of sentences) {
    const intro = s.match(PDF_CLAIM_INTRO);
    const noun = s.match(PDF_CLAIM_NOUN);
    const isQuestion = /\?\s*$/.test(s);
    const isRefusal = /\bn[ãa]o\s+(posso|consigo|tenho|gero)\b/i.test(s);
    if (intro && noun && !isQuestion && !isRefusal) {
      hit = true;
      evidence = `intro="${intro[0]}" noun="${noun[0]}"`;
      break;
    }
  }
  const ok = hit === expected;
  if (ok) pass++; else fail++;
  console.log(`${ok ? '✅' : '❌'} ${label}: ${JSON.stringify(reply.slice(0, 70))} → ${hit}${evidence ? ` [${evidence}]` : ''}`);
}
console.log(`\n${pass}/${pass + fail} passed`);
