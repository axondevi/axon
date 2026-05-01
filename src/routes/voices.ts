/**
 * Voice management for the agent builder.
 *
 *   GET  /v1/voices                   — picker payload (curated + cloned + persona)
 *   GET  /v1/voices/:id/preview.mp3   — short MP3 sample for the picker (cached 24h)
 *   POST /v1/voices/clone             — multipart upload → ElevenLabs IVC
 *   DELETE /v1/voices/:id             — remove a cloned voice (theirs only)
 *
 * All routes are mounted under the authed /v1 sub-router so they require
 * an API key. The preview endpoint is cached so 1000 visitors clicking
 * play don't hit ElevenLabs 1000 times.
 */
import { Hono } from 'hono';
import { eq, and, inArray } from 'drizzle-orm';
import { db } from '~/db';
import { userVoices, personas } from '~/db/schema';
import { Errors } from '~/lib/errors';
import { log } from '~/lib/logger';
import { synthesizeSpeech, cloneVoice, listVoices, deleteRemoteVoice } from '~/voice/elevenlabs';
import { redis } from '~/cache/redis';

const app = new Hono();

const VOICE_ID_RE = /^[A-Za-z0-9]{8,40}$/;
const PREVIEW_TTL_SEC = 86_400; // 24h
const PREVIEW_TEXT = 'Olá! Eu sou sua nova assistente. Como posso ajudar você hoje?';

// Curated short-list. Manually picked from ElevenLabs library for PT-BR
// quality. We expose by external_id so the UI doesn't depend on labels
// staying in sync. ElevenLabs sometimes changes voice descriptions; the
// id is the contract.
const CURATED_VOICES: Array<{ id: string; label: string; tagline: string; gender: 'F' | 'M' }> = [
  { id: 'XrExE9yKIg1WjnnlVkGX', label: 'Matilda',  tagline: 'Voz feminina madura, calorosa',     gender: 'F' },
  { id: '21m00Tcm4TlvDq8ikWAM', label: 'Rachel',   tagline: 'Voz feminina jovem, neutra',        gender: 'F' },
  { id: 'EXAVITQu4vr4xnSDxMaL', label: 'Sarah',    tagline: 'Voz feminina suave, profissional', gender: 'F' },
  { id: 'pNInz6obpgDQGcFmaJgB', label: 'Adam',     tagline: 'Voz masculina grave, profissional', gender: 'M' },
  { id: 'JBFqnCBsd6RMkjVDRZzb', label: 'George',   tagline: 'Voz masculina madura, séria',       gender: 'M' },
  { id: 'TX3LPaxmHKxFdv7VOQHJ', label: 'Liam',     tagline: 'Voz masculina jovem, energética',   gender: 'M' },
  { id: 'bIHbv24MWmeRgasZH58o', label: 'Will',     tagline: 'Voz masculina relaxada, casual',    gender: 'M' },
  { id: 'VR6AewLTigWG4xSOukaG', label: 'Arnold',   tagline: 'Voz masculina forte, dramática',    gender: 'M' },
];

/**
 * GET /v1/voices
 * Picker payload. Sections:
 *   - curated: hand-picked options (always available)
 *   - personas: voices attached to the 8 built-in personas (if any)
 *   - mine: voices the user picked or cloned (rows in user_voices)
 */
app.get('/', async (c) => {
  const user = c.get('user') as { id: string };

  const [mine, personaRows] = await Promise.all([
    db.select().from(userVoices).where(eq(userVoices.userId, user.id)),
    db.select().from(personas).where(eq(personas.active, true)),
  ]);

  const personaVoices = personaRows
    .filter((p) => p.voiceIdElevenlabs)
    .map((p) => ({
      external_id: p.voiceIdElevenlabs!,
      label: `${p.emoji ?? ''} ${p.name}`.trim(),
      tagline: p.tagline ?? p.toneDescription.slice(0, 80),
      source: 'persona' as const,
      preview_url: null as string | null,
    }));

  return c.json({
    curated: CURATED_VOICES.map((v) => ({
      external_id: v.id,
      label: v.label,
      tagline: v.tagline,
      gender: v.gender,
      source: 'curated' as const,
      preview_url: null,
    })),
    personas: personaVoices,
    mine: mine.map((v) => ({
      id: v.id,
      external_id: v.externalId,
      label: v.label,
      source: v.source,
      preview_url: v.previewUrl,
      created_at: v.createdAt,
    })),
  });
});

/**
 * GET /v1/voices/:id/preview.mp3
 * Generates (or returns cached) ~3-second MP3 sample of the voice
 * speaking PREVIEW_TEXT. Caches in Redis for 24h so repeated picker
 * opens don't burn TTS credits.
 */
app.get('/:id/preview.mp3', async (c) => {
  const id = c.req.param('id');
  if (!VOICE_ID_RE.test(id)) {
    return c.json({ error: 'bad_request', message: 'invalid voice id' }, 400);
  }

  const cacheKey = `voice:preview:${id}`;
  const cached = await redis.getBuffer(cacheKey).catch(() => null);
  if (cached && cached.length > 100) {
    return c.body(cached as unknown as ArrayBuffer, 200, {
      'content-type': 'audio/mpeg',
      'cache-control': 'public, max-age=86400',
      'x-axon-cache': 'hit',
    });
  }

  const r = await synthesizeSpeech({ text: PREVIEW_TEXT, voiceId: id });
  if (!r.ok || !r.audioBytes) {
    if (r.skipped) {
      return c.json({ error: 'voice_unavailable', message: 'TTS not configured on this server' }, 503);
    }
    // ElevenLabs Free Tier disables API access from datacenters /
    // VPNs ("detected_unusual_activity" — see docs). Surface a
    // friendly message so the user knows it's a billing/account issue,
    // not a bug in their voice id. 401 → 402 (Payment Required) so
    // the UI can hint "upgrade plan" without ambiguity.
    if (typeof r.error === 'string' && r.error.includes('401')) {
      return c.json(
        {
          error: 'voice_provider_unavailable',
          message:
            'ElevenLabs bloqueou a chamada (provavelmente Free Tier limitado por uso em datacenter). Faça upgrade na conta ElevenLabs ou troque a chave em ELEVENLABS_API_KEY.',
        },
        402,
      );
    }
    return c.json({ error: 'synth_failed', message: r.error ?? 'unknown' }, 502);
  }

  // Cache. ioredis accepts Buffer for setex when using setBuffer/setex —
  // we use the regular setex with a Buffer-as-string trick: store base64.
  // Simpler & lossless: store via redis client raw set with binary value.
  redis.setex(cacheKey, PREVIEW_TTL_SEC, Buffer.from(r.audioBytes)).catch(() => {});

  return c.body(r.audioBytes as unknown as ArrayBuffer, 200, {
    'content-type': 'audio/mpeg',
    'cache-control': 'public, max-age=86400',
    'x-axon-cache': 'miss',
  });
});

/**
 * POST /v1/voices/clone
 * multipart/form-data:
 *   - name      (string, required)        — display label
 *   - description (string, optional)
 *   - audio     (file or files, required) — MediaRecorder webm/opus or mp3/wav
 *
 * Forwards to ElevenLabs Instant Voice Cloning. Persists the resulting
 * voice_id in user_voices so the picker shows it on next open.
 *
 * Caps: max 3 clones per user (ElevenLabs free tier limit; conservative)
 * and 5MB per upload. Reject larger payloads early.
 */
app.post('/clone', async (c) => {
  const user = c.get('user') as { id: string };

  const existing = await db
    .select()
    .from(userVoices)
    .where(and(eq(userVoices.userId, user.id), eq(userVoices.source, 'cloned')));
  const MAX_CLONES = 3;
  if (existing.length >= MAX_CLONES) {
    return c.json(
      {
        error: 'limit_exceeded',
        message: `Você já tem ${existing.length} vozes clonadas (limite ${MAX_CLONES}). Apague uma antes de criar outra.`,
      },
      400,
    );
  }

  let body: FormData;
  try {
    body = await c.req.formData();
  } catch {
    return c.json({ error: 'bad_request', message: 'expected multipart/form-data' }, 400);
  }

  const name = String(body.get('name') ?? '').trim().slice(0, 80);
  const description = String(body.get('description') ?? '').trim().slice(0, 500) || undefined;
  if (!name) return c.json({ error: 'bad_request', message: 'name is required' }, 400);

  // Pull every value under "audio" or "files" key. Each is a Blob (Bun /
  // undici file). Cap aggregate size at 5MB.
  const samples: Blob[] = [];
  let total = 0;
  for (const key of ['audio', 'files']) {
    const all = body.getAll(key);
    for (const v of all) {
      if (v instanceof Blob) {
        total += v.size;
        if (total > 5 * 1024 * 1024) {
          return c.json({ error: 'too_large', message: 'audio total > 5MB' }, 413);
        }
        samples.push(v);
      }
    }
  }
  if (samples.length === 0) {
    return c.json({ error: 'bad_request', message: 'no audio file uploaded' }, 400);
  }

  const r = await cloneVoice({ name, description, audio: samples });
  if (!r.ok || !r.voice_id) {
    log.warn('voices.clone.failed', { user_id: user.id, error: r.error });
    return c.json(
      { error: 'clone_failed', message: r.error ?? 'unknown', upstream_status: r.status ?? null },
      r.status === 401 ? 402 : 502, // 402 to hint "upgrade plan"
    );
  }

  const [row] = await db
    .insert(userVoices)
    .values({
      userId: user.id,
      externalId: r.voice_id,
      label: name,
      source: 'cloned',
      meta: { description: description ?? null, samples: samples.length },
    })
    .onConflictDoNothing()
    .returning();

  return c.json({
    ok: true,
    id: row?.id ?? null,
    external_id: r.voice_id,
    label: name,
  });
});

/**
 * DELETE /v1/voices/:id
 * Removes the user_voices row. When the voice was cloned (source='cloned')
 * we also fire a best-effort delete to ElevenLabs so the operator's
 * voice library doesn't leak orphans. Curated/persona ids in user_voices
 * are local-only — no remote delete.
 */
app.delete('/:id', async (c) => {
  const user = c.get('user') as { id: string };
  const id = c.req.param('id');

  const [row] = await db
    .select()
    .from(userVoices)
    .where(and(eq(userVoices.id, id), eq(userVoices.userId, user.id)))
    .limit(1);
  if (!row) throw Errors.notFound('Voice');

  await db.delete(userVoices).where(eq(userVoices.id, id));

  if (row.source === 'cloned') {
    // Best-effort. If ElevenLabs is down, we still drop the local row.
    deleteRemoteVoice(row.externalId).catch(() => {});
  }
  return c.json({ ok: true });
});

/**
 * POST /v1/voices/sync
 * Reconcile user_voices with what's actually in the operator's
 * ElevenLabs account — useful after manual deletes in the dashboard.
 * Only touches rows the user owns. We never auto-create rows here
 * (cloned voices are added at /clone time); we only DROP local rows
 * whose external_id no longer exists upstream.
 */
app.post('/sync', async (c) => {
  const user = c.get('user') as { id: string };
  const remote = await listVoices();
  const remoteIds = new Set(remote.map((v) => v.voice_id));

  const mine = await db.select().from(userVoices).where(eq(userVoices.userId, user.id));
  const stale = mine.filter((v) => v.source === 'cloned' && !remoteIds.has(v.externalId));
  if (stale.length > 0) {
    await db.delete(userVoices).where(
      and(
        eq(userVoices.userId, user.id),
        inArray(userVoices.id, stale.map((s) => s.id)),
      ),
    );
  }
  return c.json({
    pruned: stale.length,
    remaining: mine.length - stale.length,
    remote_count: remote.length,
  });
});

export default app;
