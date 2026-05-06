/**
 * Smoke test for issueToPatchText grammar inversion. Run with:
 *   bun run scripts/test-patch-grammar.ts
 *
 * Drops the function body verbatim from agents.ts so we don't have to
 * export it just for testing — the function is private to that module.
 */
function issueToPatchText(issue: string): string {
  const trimmed = issue.trim().replace(/\s+/g, ' ');
  if (!trimmed) return '';

  const conjugations: Array<[RegExp, (tail: string) => string]> = [
    [/^não\s+respondeu\b\s*(.*)$/i, (t) => 'Sempre responda ' + t.trim()],
    [/^não\s+usou\b\s*(.*)$/i, (t) => 'Sempre use ' + t.trim()],
    [/^não\s+chamou\b\s*(.*)$/i, (t) => 'Sempre chame ' + t.trim()],
    [/^não\s+pediu\b\s*(.*)$/i, (t) => 'Sempre peça ' + t.trim()],
    [/^não\s+confirmou\b\s*(.*)$/i, (t) => 'Sempre confirme ' + t.trim()],
    [/^não\s+seguiu\b\s*(.*)$/i, (t) => 'Sempre siga ' + t.trim()],
    [/^não\s+respeitou\b\s*(.*)$/i, (t) => 'Sempre respeite ' + t.trim()],
    [/^não\s+considerou\b\s*(.*)$/i, (t) => 'Sempre considere ' + t.trim()],
    [/^não\s+manteve\b\s*(.*)$/i, (t) => 'Sempre mantenha ' + t.trim()],
    [/^não\s+verificou\b\s*(.*)$/i, (t) => 'Sempre verifique ' + t.trim()],
    [/^não\s+deveria\s+ter\s+(\w+)\s*(.*)$/i, (t) => 'Sempre ' + t.trim()],
    [/^não\s+([a-záéíóúãõç]+r)\b\s*(.*)$/i, (t) => 'Sempre ' + t.trim()],
    [/^não\s+(.*)$/i, (t) => 'Sempre ' + t.trim()],
    [/^ignor(?:ou|ar|ado)\b\s*(.*)$/i, (t) => 'Considere ' + t.trim()],
    [/^(?:alucinou|inventou)\b\s*(.*)$/i, (t) =>
      t.trim()
        ? 'Não invente ' + t.trim() + ' — use só dado real (tool, business_info ou memória).'
        : 'Não invente fato. Use só dado real (tool, business_info ou memória).'],
    [/^respondeu\s+sem\s+(.*)$/i, (t) => 'Não responda sem ' + t.trim()],
    [/^pergunt(?:ou|ar)\s+(?:de\s+novo|novamente)\s*(.*)$/i, (t) =>
      t.trim() ? 'Não repita a pergunta sobre ' + t.trim() : 'Não repita perguntas que o cliente já respondeu.'],
    [/^repet(?:iu|ir)\s+(.*)$/i, (t) => 'Não repita ' + t.trim()],
    [/^(?:deflectiu|desviou\s+de)\s+(.*)$/i, (t) => 'Responda ' + t.trim() + ' em vez de desviar.'],
    [/^(?:usou\s+)?tool\s+errada\b/i, () => 'Escolha a tool correta antes de responder — leia a descrição da tool.'],
  ];

  for (const [re, build] of conjugations) {
    const m = trimmed.match(re);
    if (m) {
      const tail = (m[m.length - 1] as string | undefined)?.replace(/^[.,;:\s]+/, '') || '';
      const out = build(tail).replace(/\s+/g, ' ').trim();
      if (out.length > 8) return out.endsWith('.') ? out : out + '.';
    }
  }
  return 'Atenção: ' + trimmed + (trimmed.endsWith('.') ? '' : '.');
}

const cases = [
  'não respondeu pergunta do cliente',
  'não usou tool de catálogo',
  'não pediu clarificação quando devia',
  'não confirmou horário do agendamento',
  'não respeitou business_info',
  'não considerou memória do contato',
  'ignorou business_info',
  'ignorou memória do contato',
  'alucinou preço do imóvel',
  'inventou endereço',
  'respondeu sem usar tool',
  'repetiu a mesma pergunta',
  'perguntou de novo orçamento',
  'desviou de pergunta sobre fotos',
  'tool errada',
  'usou tool errada',
  'random unstructured judge issue',
];
for (const c of cases) {
  console.log(JSON.stringify(c).padEnd(45) + ' → ' + JSON.stringify(issueToPatchText(c)));
}
