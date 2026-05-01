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

/**
 * List voices in the operator's ElevenLabs account.
 * Returns an empty array when ELEVENLABS_API_KEY is unset (silent skip).
 */
export interface ElevenLabsVoice {
  voice_id: string;
  name: string;
  category?: string;
  description?: string;
  preview_url?: string;
  labels?: Record<string, string>;
}
export async function listVoices(): Promise<ElevenLabsVoice[]> {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) return [];
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 10_000);
    const res = await fetch(`${EL_BASE}/voices`, {
      headers: { 'xi-api-key': apiKey, Accept: 'application/json' },
      signal: ctl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) {
      log.warn('voice.list.api_error', { status: res.status });
      return [];
    }
    const data = (await res.json()) as { voices?: ElevenLabsVoice[] };
    return data.voices ?? [];
  } catch (err) {
    log.warn('voice.list.error', { error: err instanceof Error ? err.message : String(err) });
    return [];
  }
}

/**
 * Instant Voice Cloning. The user uploads ~30s-60s of clean audio and
 * gets a voice_id back. ElevenLabs IVC works on Starter ($5/mo) and up;
 * Free tier rejects with 401 (the `unusable_shared_voice` error code).
 *
 * `audio` is a single Blob/File or array of Blobs (MediaRecorder
 * produces webm/opus on Chrome — ElevenLabs accepts it). `name` is what
 * shows up in the user's ElevenLabs library; we also store it locally.
 */
export interface CloneResult {
  ok: boolean;
  voice_id?: string;
  error?: string;
  status?: number;
}
export async function cloneVoice(opts: {
  name: string;
  description?: string;
  audio: Blob | Blob[];
}): Promise<CloneResult> {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) return { ok: false, error: 'voice cloning unavailable (ELEVENLABS_API_KEY not configured)' };
  const audios = Array.isArray(opts.audio) ? opts.audio : [opts.audio];
  if (audios.length === 0 || audios.every((a) => a.size === 0)) {
    return { ok: false, error: 'audio sample is empty' };
  }

  const fd = new FormData();
  fd.append('name', opts.name.slice(0, 80));
  if (opts.description) fd.append('description', opts.description.slice(0, 500));
  audios.forEach((blob, idx) => {
    // ElevenLabs expects field name 'files' (plural) for IVC; extension
    // matters less than the mimetype on the blob, but giving the file a
    // sensible name makes their dashboard readable.
    const ext = blob.type.includes('webm') ? 'webm' : blob.type.includes('mp3') ? 'mp3' : blob.type.includes('wav') ? 'wav' : 'audio';
    fd.append('files', blob, `sample-${idx + 1}.${ext}`);
  });

  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 60_000);
    const res = await fetch(`${EL_BASE}/voices/add`, {
      method: 'POST',
      headers: { 'xi-api-key': apiKey, Accept: 'application/json' },
      body: fd,
      signal: ctl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      log.warn('voice.clone.api_error', { status: res.status, body: text.slice(0, 240) });
      return { ok: false, error: `elevenlabs ${res.status}: ${text.slice(0, 200)}`, status: res.status };
    }
    const j = (await res.json()) as { voice_id?: string };
    if (!j.voice_id) return { ok: false, error: 'no voice_id in response' };
    return { ok: true, voice_id: j.voice_id };
  } catch (err) {
    log.warn('voice.clone.error', { error: err instanceof Error ? err.message : String(err) });
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Delete a cloned voice from ElevenLabs (best-effort cleanup on user delete). */
export async function deleteRemoteVoice(voiceId: string): Promise<{ ok: boolean }> {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) return { ok: false };
  try {
    const res = await fetch(`${EL_BASE}/voices/${encodeURIComponent(voiceId)}`, {
      method: 'DELETE',
      headers: { 'xi-api-key': apiKey },
    });
    return { ok: res.ok };
  } catch {
    return { ok: false };
  }
}
