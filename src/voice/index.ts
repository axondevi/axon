/**
 * Coordinator de TTS — escolhe provider em runtime.
 *
 * Ordem de preferência:
 *   1. Cartesia (se `CARTESIA_API_KEY` setada) — mais barato, latência
 *      menor, free tier mais generoso pra PT-BR.
 *   2. ElevenLabs (se `ELEVENLABS_API_KEY` setada) — melhor qualidade
 *      pra clonagem; fallback automático quando Cartesia falha (5xx) ou
 *      key não configurada.
 *   3. Skip silencioso.
 *
 * `voiceId` formato detection:
 *   - UUID com hífens → Cartesia voice id, passa direto.
 *   - Alfanumérico sem hífen (ElevenLabs format) → ignorado pelo
 *     Cartesia (cai no env default), passado pro ElevenLabs.
 */
import { log } from '~/lib/logger';
import { synthesizeSpeechCartesia } from './cartesia';
import {
  synthesizeSpeech as synthesizeSpeechElevenLabs,
  cloneVoice,
  listVoices,
  deleteRemoteVoice,
  type ElevenLabsVoice,
  type SynthesizeResult,
} from './elevenlabs';

export { cloneVoice, listVoices, deleteRemoteVoice };
export type { ElevenLabsVoice, SynthesizeResult };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function synthesizeSpeech(opts: {
  text: string;
  voiceId?: string;
  modelId?: string;
}): Promise<SynthesizeResult> {
  const cartesiaKey = process.env.CARTESIA_API_KEY;
  const elevenKey = process.env.ELEVENLABS_API_KEY;

  if (cartesiaKey) {
    const cartesiaVoiceId = opts.voiceId && UUID_RE.test(opts.voiceId) ? opts.voiceId : undefined;
    const r = await synthesizeSpeechCartesia({
      text: opts.text,
      voiceId: cartesiaVoiceId,
    });
    if (r.ok) return r;
    if (!elevenKey) return r;
    log.info('voice.cartesia.fallback_to_elevenlabs', { error: r.error });
  }

  return synthesizeSpeechElevenLabs(opts);
}
