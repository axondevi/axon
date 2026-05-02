/**
 * Smoke test do adapter Cartesia.
 *
 * Uso:
 *   CARTESIA_API_KEY=sk_... bun scripts/smoke-cartesia.ts
 *   CARTESIA_API_KEY=sk_... CARTESIA_VOICE_ID=<uuid> bun scripts/smoke-cartesia.ts
 *
 * Sai com código 0 + grava `cartesia-smoke.mp3` se sintetizou; 1 caso contrário.
 */
import { synthesizeSpeechCartesia } from '~/voice/cartesia';
import { writeFileSync } from 'node:fs';

const TEXT = 'Olá! Eu sou sua nova assistente. Como posso ajudar você hoje?';

(async () => {
  if (!process.env.CARTESIA_API_KEY) {
    console.error('CARTESIA_API_KEY não setada. Passe inline ou exporte antes.');
    process.exit(1);
  }
  console.log('→ Pedindo TTS Cartesia...');
  const r = await synthesizeSpeechCartesia({ text: TEXT });
  if (!r.ok || !r.audioBytes) {
    console.error('falhou:', { skipped: r.skipped, error: r.error });
    process.exit(1);
  }
  const out = `cartesia-smoke.mp3`;
  writeFileSync(out, r.audioBytes);
  console.log(`✓ ${r.audioBytes.length} bytes gravados em ./${out} (${r.mimeType})`);
})();
