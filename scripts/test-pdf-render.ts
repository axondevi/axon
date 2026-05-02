// Smoke test the renderPdf path locally — generates a sample doc, writes
// to disk so the operator can open it and visually confirm layout +
// PT-BR accents render correctly.
import { renderPdf, suggestPdfFilename } from '../src/agents/pdf-renderer';
import { writeFileSync } from 'node:fs';

const buf = await renderPdf({
  title: 'Comprovante de Agendamento',
  body:
    'Sua consulta está confirmada para o dia 15 de maio de 2026, às 14:30, ' +
    'com a Dra. Elisa Drumond na Recepção da Clínica.',
  sections: [
    { heading: 'Paciente', content: 'Pedro Silva — CPF 123.456.789-00' },
    { heading: 'Endereço', content: 'Rua das Flores, 100 — São Paulo, SP' },
    { heading: 'Valor', content: 'R$ 250,00 (particular)' },
    { heading: 'Observações', content: 'Trazer exames recentes e cartão do plano (caso utilize convênio).' },
  ],
  businessName: 'Clínica Drumond',
});

const out = `/tmp/${suggestPdfFilename('Comprovante Agendamento')}`;
writeFileSync(out, buf);
console.log(`OK — wrote ${buf.length} bytes to ${out}`);
