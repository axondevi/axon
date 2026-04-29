/**
 * Speech-to-Text via Deepgram Nova-3.
 *
 * Why Deepgram: best PT-BR accuracy (~95% on noisy WhatsApp audio),
 * sub-second latency, $0.0043/minute pay-as-you-go (~$0.005 for typical
 * 30s voice msg). $200 free credits at signup last for ~750 hours of
 * audio — enough for thousands of customer turns.
 *
 * WhatsApp voice messages are typically OPUS/OGG, ~30-90s. Deepgram
 * accepts the format directly via the binary upload endpoint.
 *
 * Returns plain transcript text (UTF-8). No-op when DEEPGRAM_API_KEY
 * is unset — caller should respond with "couldn't process audio,
 * could you write?" to keep the conversation moving.
 */
import { log } from '~/lib/logger';

const DG_BASE = 'https://api.deepgram.com/v1/listen';
const FETCH_TIMEOUT_MS = 30_000;

export interface TranscribeResult {
  ok: boolean;
  transcript?: string;
  /** Word-level confidence (0-1). When low (<0.6) caller may want to ask
   *  the user to repeat. */
  confidence?: number;
  /** Audio duration in seconds — useful for usage tracking. */
  durationSec?: number;
  skipped?: boolean;
  error?: string;
}

/**
 * Transcribe a WhatsApp voice message. Auto-detects PT-BR (or sender's
 * language if multilingual=true). Smart-format=true normalizes numbers
 * ("vinte cinco" → "25") and punctuation.
 */
export async function transcribeAudio(opts: {
  audioBytes: Uint8Array | ArrayBuffer;
  /** MIME — Deepgram uses this to pick the codec. WhatsApp = audio/ogg. */
  mimeType: string;
  /** Default 'pt-BR'. Pass undefined for auto-detect. */
  language?: string;
}): Promise<TranscribeResult> {
  const apiKey = process.env.DEEPGRAM_API_KEY;
  if (!apiKey) {
    log.info('voice.transcribe.skipped', { reason: 'no_api_key' });
    return { ok: false, skipped: true };
  }

  const params = new URLSearchParams({
    model: 'nova-3',
    smart_format: 'true',
    punctuate: 'true',
    detect_language: opts.language ? 'false' : 'true',
  });
  if (opts.language) params.set('language', opts.language);

  const bytes = opts.audioBytes instanceof ArrayBuffer
    ? new Uint8Array(opts.audioBytes)
    : opts.audioBytes;

  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
    const res = await fetch(`${DG_BASE}?${params}`, {
      method: 'POST',
      signal: ctl.signal,
      headers: {
        Authorization: `Token ${apiKey}`,
        'Content-Type': opts.mimeType,
      },
      // Wrap in Blob — TS BodyInit doesn't include bare Uint8Array even though
      // runtime fetch accepts it. Cast through `any` since the runtime supports
      // it (Bun + Node 20+) but TS DOM lib hasn't caught up.
      body: new Blob([bytes as any], { type: opts.mimeType }),
    });
    clearTimeout(timer);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      log.warn('voice.transcribe.api_error', { status: res.status, body: text.slice(0, 240) });
      return { ok: false, error: `deepgram ${res.status}` };
    }
    const data: any = await res.json();
    const alt = data?.results?.channels?.[0]?.alternatives?.[0];
    const transcript: string | undefined = alt?.transcript;
    const confidence: number | undefined = alt?.confidence;
    const durationSec: number | undefined = data?.metadata?.duration;
    if (!transcript) {
      return { ok: false, error: 'empty transcript' };
    }
    return { ok: true, transcript: transcript.trim(), confidence, durationSec };
  } catch (err: any) {
    log.warn('voice.transcribe.error', { error: err.message || String(err) });
    return { ok: false, error: err.message || String(err) };
  }
}
