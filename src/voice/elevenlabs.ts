/**
 * Text-to-Speech via ElevenLabs.
 *
 * Why ElevenLabs: voice quality dwarfs everything else for PT-BR (Eleven
 * v3 supports Portuguese natively with natural prosody). Free tier =
 * 10k characters/month, paid = $5/mo for 30k chars. WhatsApp audio is
 * usually under 200 chars per reply, so 30k chars ≈ 150 voice replies/mo
 * — enough for early adopters, scales smoothly.
 *
 * Returns MP3 bytes. Evolution accepts MP3 in sendMedia mediatype:'audio'
 * with mimetype:'audio/mpeg'. Sets ptt:true on the inbound payload makes
 * WhatsApp display it as a voice message (mic icon) vs an audio file.
 *
 * No-op when ELEVENLABS_API_KEY is unset.
 */
import { log } from '~/lib/logger';

const EL_BASE = 'https://api.elevenlabs.io/v1';
const FETCH_TIMEOUT_MS = 25_000;

/** Eleven v3 multilingual voice — Mariana (PT-BR native, female).
 *  Override via ELEVENLABS_VOICE_ID env. List at elevenlabs.io/voices. */
const DEFAULT_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM';

export interface SynthesizeResult {
  ok: boolean;
  /** Raw MP3 bytes. Caller passes via sendMedia. */
  audioBytes?: Uint8Array;
  mimeType?: string;
  durationSec?: number;
  skipped?: boolean;
  error?: string;
}

export async function synthesizeSpeech(opts: {
  text: string;
  voiceId?: string;
  /** PT-BR by default. */
  modelId?: string;
}): Promise<SynthesizeResult> {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    log.info('voice.synthesize.skipped', { reason: 'no_api_key' });
    return { ok: false, skipped: true };
  }
  if (!opts.text || opts.text.trim().length === 0) {
    return { ok: false, error: 'empty text' };
  }
  // Cap at 600 chars — anything longer suggests the agent is rambling, and
  // long audio messages annoy WhatsApp users. (~30s of speech.)
  const text = opts.text.slice(0, 600);
  const voiceId = opts.voiceId || DEFAULT_VOICE_ID;
  const modelId = opts.modelId || 'eleven_multilingual_v2';

  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
    const res = await fetch(`${EL_BASE}/text-to-speech/${voiceId}?output_format=mp3_44100_128`, {
      method: 'POST',
      signal: ctl.signal,
      headers: {
        'xi-api-key': apiKey,
        'Content-Type': 'application/json',
        Accept: 'audio/mpeg',
      },
      body: JSON.stringify({
        text,
        model_id: modelId,
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75,
          style: 0.2,
          use_speaker_boost: true,
        },
      }),
    });
    clearTimeout(timer);
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      log.warn('voice.synthesize.api_error', { status: res.status, body: errText.slice(0, 240) });
      return { ok: false, error: `elevenlabs ${res.status}` };
    }
    const arrayBuffer = await res.arrayBuffer();
    return {
      ok: true,
      audioBytes: new Uint8Array(arrayBuffer),
      mimeType: 'audio/mpeg',
      durationSec: undefined, // could decode mp3 frames to measure but not worth it
    };
  } catch (err: any) {
    log.warn('voice.synthesize.error', { error: err.message || String(err) });
    return { ok: false, error: err.message || String(err) };
  }
}
