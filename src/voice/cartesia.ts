/**
 * Text-to-Speech via Cartesia (Sonic-2).
 *
 * Concorrente direta da ElevenLabs em qualidade — Sonic-2 é multilingue
 * e suporta PT-BR nativamente. Free tier mais generoso e latência menor
 * (sub-200ms time-to-first-byte). Usado como provider primário quando
 * `CARTESIA_API_KEY` está setado; ElevenLabs vira fallback.
 *
 * Endpoint `/tts/bytes` retorna áudio binário (sem streaming) — bom o
 * suficiente pra WhatsApp, que espera o blob completo. Output em MP3
 * pra compat direta com Evolution `sendMedia mediatype:'audio'`.
 *
 * No-op silencioso quando `CARTESIA_API_KEY` está unset.
 */
import { log } from '~/lib/logger';

const CARTESIA_BASE = 'https://api.cartesia.ai';
const CARTESIA_VERSION = '2024-11-13';
const FETCH_TIMEOUT_MS = 25_000;

/** Voz default Cartesia PT-BR — Larissa (feminina, friendly).
 *  Operador pode sobrescrever via `CARTESIA_VOICE_ID`. Catálogo:
 *  https://play.cartesia.ai/voices ou GET /voices na API. */
const DEFAULT_VOICE_ID = process.env.CARTESIA_VOICE_ID || '8d826d43-20ad-4c56-8d37-1048eccca1bf';
const DEFAULT_MODEL_ID = process.env.CARTESIA_MODEL_ID || 'sonic-2';

export interface CartesiaSynthesizeResult {
  ok: boolean;
  audioBytes?: Uint8Array;
  mimeType?: string;
  durationSec?: number;
  skipped?: boolean;
  error?: string;
}

export async function synthesizeSpeechCartesia(opts: {
  text: string;
  voiceId?: string;
  modelId?: string;
  language?: string;
}): Promise<CartesiaSynthesizeResult> {
  const apiKey = process.env.CARTESIA_API_KEY;
  if (!apiKey) {
    return { ok: false, skipped: true };
  }
  if (!opts.text || opts.text.trim().length === 0) {
    return { ok: false, error: 'empty text' };
  }
  // Cap igual ao ElevenLabs — 600 chars (~30s áudio).
  const text = opts.text.slice(0, 600);
  const voiceId = opts.voiceId || DEFAULT_VOICE_ID;
  const modelId = opts.modelId || DEFAULT_MODEL_ID;
  const language = opts.language || 'pt';

  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
    const res = await fetch(`${CARTESIA_BASE}/tts/bytes`, {
      method: 'POST',
      signal: ctl.signal,
      headers: {
        'X-API-Key': apiKey,
        'Cartesia-Version': CARTESIA_VERSION,
        'Content-Type': 'application/json',
        Accept: 'audio/mpeg',
      },
      body: JSON.stringify({
        model_id: modelId,
        transcript: text,
        voice: { mode: 'id', id: voiceId },
        output_format: {
          container: 'mp3',
          bit_rate: 128000,
          sample_rate: 44100,
        },
        language,
      }),
    });
    clearTimeout(timer);
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      log.warn('voice.cartesia.api_error', { status: res.status, body: errText.slice(0, 240) });
      void import('~/lib/metrics').then(({ bumpCounter }) => {
        bumpCounter('axon_upstream_failures_total', { provider: 'cartesia', kind: 'tts', status: String(res.status) });
      });
      return { ok: false, error: `cartesia ${res.status}` };
    }
    const arrayBuffer = await res.arrayBuffer();
    return {
      ok: true,
      audioBytes: new Uint8Array(arrayBuffer),
      mimeType: 'audio/mpeg',
    };
  } catch (err: any) {
    log.warn('voice.cartesia.error', { error: err.message || String(err) });
    return { ok: false, error: err.message || String(err) };
  }
}
