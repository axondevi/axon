/**
 * LLM provider cascade with auto-fallback on rate limit.
 *
 * Why this exists:
 * Groq's free tier hits a daily 100k-token cap easily once an agent runs
 * any non-trivial traffic. When the cap hits, every turn 500s with
 * "rate limit reached" — the user-facing experience is total failure.
 *
 * This module wraps the Groq call in a cascade — Groq → Gemini → Cohere
 * (each only used if its UPSTREAM_KEY_* env is set). When a provider hits
 * rate-limit, we mark it cooled-down (60s for short windows, 1h for the
 * daily TPD ceiling) and use the next one. Subsequent turns skip the
 * cooled provider until cooldown expires.
 *
 * The PC Agent project uses an identical pattern (Groq → Gemini → Cohere
 * → Ollama). The Axon variant is server-side, no Ollama, but the
 * underlying robustness goal is the same.
 *
 * All providers respond in OpenAI chat-completions schema (model, messages,
 * tools, tool_calls, choices[0].message). Gemini exposes an OpenAI-compat
 * endpoint and Cohere too — so the request body and response parsing stay
 * identical across providers.
 */
import { upstreamKeyFor } from '~/config';

export interface LLMRequest {
  /** Pre-built history (system + user/assistant/tool turns). */
  messages: Array<{ role: string; content?: string | null; tool_calls?: any; tool_call_id?: string }>;
  /** OpenAI-shaped tools array, or undefined if the agent has none. */
  tools?: any[];
  max_tokens?: number;
  temperature?: number;
  /** Penalize tokens already seen in the response — kills "Aqui é a
   *  clínica… Aqui é a clínica…" type loops. 0–2 (OpenAI scale). */
  frequency_penalty?: number;
  /** Encourage the model to introduce new topics rather than retread
   *  the same content. 0–2 (OpenAI scale). */
  presence_penalty?: number;
  /** OpenAI-shape tool_choice. Default 'auto' when tools are present.
   *  Stays as a hook on the request type (not currently set by callers) —
   *  the agent runtime relies on prompt + good tool descriptions instead
   *  of forcing a specific choice. Available if a future feature genuinely
   *  needs to constrain the model's choice on a specific turn. */
  tool_choice?: 'auto' | 'required' | 'none' | { type: 'function'; function: { name: string } };
}

export interface LLMResponse {
  /** Provider that actually answered (for telemetry / debugging). */
  provider: string;
  /** OpenAI-shaped raw choices[0].message. */
  message: any;
  /** Whatever the upstream returned for finish_reason. */
  finish_reason?: string;
}

interface ProviderConfig {
  name: string;
  /** Full chat-completions URL. All providers we use expose OAI-compatible /chat/completions. */
  endpoint: string;
  /** Slug passed to upstreamKeyFor — must match an env UPSTREAM_KEY_* */
  keySlug: string;
  /** Model id the provider expects. */
  model: string;
  /** True if the provider supports tool_calls reliably. Cohere, for
   *  example, often returns empty `acao` when many tools are exposed —
   *  flag false and the cascade will skip it for tool-using turns. */
  supportsTools: boolean;
  /** True if the provider accepts BOTH frequency_penalty and
   *  presence_penalty in the same request. Cohere rejects the combo
   *  with HTTP 400 ("invalid request: frequency_penalty with
   *  presence_penalty is not supported for this model"), which made
   *  the whole cascade fail when Groq + Gemini were both rate-limited
   *  → user saw "Desculpe, problema técnico" repeatedly. When false,
   *  we strip both penalties from the request. */
  supportsRepetitionPenalties: boolean;
}

/**
 * Provider order: best-tool-call to last-resort.
 *
 * Gemini 2.5 Flash:   PRIMARY. End-to-end testing showed Llama-3.x via Groq
 *                     systematically refuses to call tools on PT-BR conversations
 *                     (it would say "te mandei o catálogo 📄" and skip the
 *                     send_catalog_pdf call). Gemini calls them reliably.
 *                     1500 req/day free quota.
 * Groq llama-3.3-70b: FALLBACK. Faster latency, hard daily token cap. Good for
 *                     turns without tool calling, or when Gemini quota burns.
 * Cohere command-r-plus: LAST RESORT. Generous free tier but often emits empty
 *                     `acao` when tools are present. Text-only fallback.
 */
const PROVIDERS: ProviderConfig[] = [
  {
    name: 'gemini',
    endpoint: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    keySlug: 'gemini',
    model: 'gemini-2.5-flash',
    supportsTools: true,
    // Gemini's OAI-compat layer accepts the params but silently ignores
    // them. Sending is harmless. Keeping true so we don't have to gate.
    supportsRepetitionPenalties: true,
  },
  {
    // Same key, separate per-day quota at Google. When the primary Flash
    // hits 1500/day, Flash-Lite still answers — keeps the agent off the
    // text-only Cohere fallback for as long as possible.
    name: 'gemini-lite',
    endpoint: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    keySlug: 'gemini',
    model: 'gemini-2.5-flash-lite',
    supportsTools: true,
    supportsRepetitionPenalties: true,
  },
  {
    name: 'groq',
    endpoint: 'https://api.groq.com/openai/v1/chat/completions',
    keySlug: 'groq',
    model: 'llama-3.3-70b-versatile',
    supportsTools: true,
    supportsRepetitionPenalties: true,
  },
  {
    // 4th tool-capable provider — Qwen 72B via SiliconFlow's OAI-compatible
    // endpoint. Added 2026-05-07 after production case 5219 showed the
    // cascade falling through to Cohere (text-only) when all 3 primaries
    // were rate-limited. Cohere with tools STRIPPED inevitably hallucinates
    // URLs/types on tool-needed turns. Qwen handles tool calling well and
    // the SiliconFlow free tier is generous enough to act as a real safety
    // net. Set SILICONFLOW_API_KEY in env to enable.
    name: 'siliconflow-qwen',
    endpoint: 'https://api.siliconflow.com/v1/chat/completions',
    keySlug: 'siliconflow',
    model: 'Qwen/Qwen2.5-72B-Instruct',
    supportsTools: true,
    supportsRepetitionPenalties: true,
  },
  {
    name: 'cohere',
    endpoint: 'https://api.cohere.com/compatibility/v1/chat/completions',
    keySlug: 'cohere',
    model: 'command-r-plus-08-2024',
    // Tool-call reliability is poor with many tools — the smart selector
    // already narrows the catalog, but Cohere still mis-emits `acao: ""`
    // sometimes. Keep it as text-fallback only.
    supportsTools: false,
    // Cohere's compat layer returns 400 if BOTH penalties are present.
    // Strip them entirely for Cohere requests so the fallback path
    // doesn't 400-cascade when Groq + Gemini are both rate-limited.
    supportsRepetitionPenalties: false,
  },
];

/**
 * Module-level cooldowns. Map<providerName, expiry-epoch-ms>.
 * In-memory only — clears on restart, which is fine: a fresh deploy
 * effectively resets the rolling window guesses.
 */
const cooldowns = new Map<string, number>();

function isCooled(name: string): boolean {
  const until = cooldowns.get(name);
  return typeof until === 'number' && Date.now() < until;
}

function setCooldown(name: string, ms: number): void {
  cooldowns.set(name, Date.now() + ms);
}

/**
 * Detect the kind of rate-limit error in the upstream response so we can
 * pick the right cooldown duration. TPD (per-day) errors are "wait an
 * hour". TPM (per-minute) are "wait a minute". Anything else = 60s.
 *
 * Returns ms to sleep, or 0 if the error is not a rate limit.
 */
function rateLimitCooldownMs(status: number, body: string): number {
  // 429 is the canonical rate-limit code, but Groq sometimes returns 503
  // with the same message shape under capacity pressure.
  if (status !== 429 && status !== 503) return 0;
  const lc = body.toLowerCase();
  if (lc.includes('tokens per day') || lc.includes(' tpd ')) return 60 * 60 * 1000;
  if (lc.includes('tokens per minute') || lc.includes(' tpm ')) return 60 * 1000;
  if (lc.includes('rate limit') || lc.includes('quota')) return 60 * 1000;
  return 60 * 1000;  // unknown 429/503 — short cooldown is safer than skipping
}

/**
 * Send the chat-completions request through the first available provider
 * that isn't currently rate-limited. Throws if every configured provider
 * is exhausted.
 */
export async function chatCompletionWithFallback(req: LLMRequest): Promise<LLMResponse> {
  const wantsTools = (req.tools?.length ?? 0) > 0;
  const candidates = PROVIDERS.filter((p) => {
    if (!upstreamKeyFor(p.keySlug)) return false;     // no key configured
    if (isCooled(p.name)) return false;                // cooling down
    if (wantsTools && !p.supportsTools) return false;  // can't run this turn
    return true;
  });

  if (candidates.length === 0) {
    // Edge case: every tool-capable provider cooled or none configured.
    // Fall back to any-key-set provider (ignore cooldown) so we at least
    // try — better a likely 429 than a hard fail.
    const anyConfigured = PROVIDERS.filter((p) => upstreamKeyFor(p.keySlug));
    if (anyConfigured.length === 0) {
      throw new Error('No LLM provider configured (set UPSTREAM_KEY_GROQ at minimum)');
    }
    candidates.push(...anyConfigured);
  }

  // ─── Last-resort tier removed (was: text-only Cohere fallback) ───
  // Production case 5219: Gemini + Gemini-Lite + Groq all rate-limited,
  // fallback hit Cohere which has supportsTools=false. Tools were
  // STRIPPED, LLM had nothing to call, inevitably hallucinated URL
  // ("https://site.com/imoveis/IM-A-LDJK6X") AND property type
  // ("sobrado em condomínio fechado" for an actually-commercial item).
  // Customer saw the lie, trusted it, found the URL was 404. Catastrophic
  // UX worse than a clean 500.
  //
  // New policy: when the request needs tools, only run on tool-capable
  // providers. If all are cooled, throw — caller (whatsapp.ts) catches
  // and emits an honest "tive lentidão técnica, me chama em alguns
  // segundos" message instead of a fabricated reply. Cohere is still
  // used for text-only requests (no tools array passed) where there's
  // nothing to fabricate.

  let lastError = '';
  for (const provider of candidates) {
    const apiKey = upstreamKeyFor(provider.keySlug)!;
    const body: Record<string, unknown> = {
      model: provider.model,
      messages: req.messages,
      max_tokens: req.max_tokens ?? 4096,
      // 0.7 is the chat sweet spot for Llama 3.3 — variety without
      // breaking tool-call structure. The earlier 0.3 default was
      // tuned for deterministic API gateway runs and made the WhatsApp
      // persona sound like a stuck record.
      temperature: req.temperature ?? 0.7,
    };
    // Anti-repetition penalties — only attach when the caller asked
    // for them AND the provider accepts both together. Cohere returns
    // 400 if both are sent, so we strip them entirely for Cohere; the
    // fallback path then succeeds with plain temperature instead of
    // tripping "All providers exhausted" on every Groq/Gemini blip.
    if (provider.supportsRepetitionPenalties) {
      if (req.frequency_penalty !== undefined) body.frequency_penalty = req.frequency_penalty;
      if (req.presence_penalty !== undefined) body.presence_penalty = req.presence_penalty;
    }
    // Only attach tools if BOTH the request wants them AND the provider
    // supports them. This handles the text-only fallback path where Cohere
    // gets the request without tools to keep it from emitting empty action.
    if (req.tools?.length && provider.supportsTools) {
      body.tools = req.tools;
      // Default 'auto' lets the model decide; caller can override to
      // 'required' when the user's message clearly asks for an action so
      // the model can't just promise it in text and skip the call.
      body.tool_choice = req.tool_choice ?? 'auto';
    }

    try {
      const res = await fetch(provider.endpoint, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });

      if (res.ok) {
        const json: any = await res.json();
        const choice = json.choices?.[0];
        if (!choice) {
          lastError = `${provider.name}: no choices in response`;
          continue;
        }
        return {
          provider: provider.name,
          message: choice.message ?? {},
          finish_reason: choice.finish_reason,
        };
      }

      // Non-OK — rate limit? cooldown the provider and continue cascade.
      const text = await res.text().catch(() => '');
      const cooldownMs = rateLimitCooldownMs(res.status, text);
      if (cooldownMs > 0) {
        setCooldown(provider.name, cooldownMs);
        lastError = `${provider.name} rate-limited (${res.status})`;
        continue;
      }

      // Other 4xx/5xx: short cooldown, try next.
      setCooldown(provider.name, 30 * 1000);
      lastError = `${provider.name} ${res.status}: ${text.slice(0, 200)}`;
    } catch (err: any) {
      // Network / timeout — same as 5xx, short cooldown and try next.
      setCooldown(provider.name, 30 * 1000);
      lastError = `${provider.name} fetch failed: ${err.message || String(err)}`;
    }
  }

  throw new Error(
    `All LLM providers exhausted. Last error: ${lastError || '(none)'}`,
  );
}

/**
 * Test helper — clear all cooldowns. Production code never calls this.
 */
export function _resetCooldowns(): void {
  cooldowns.clear();
}

/**
 * Snapshot of provider state for /health-style endpoints.
 */
export function providerStatus(): Array<{ name: string; configured: boolean; cooledForMs: number }> {
  return PROVIDERS.map((p) => {
    const until = cooldowns.get(p.name) || 0;
    return {
      name: p.name,
      configured: !!upstreamKeyFor(p.keySlug),
      cooledForMs: Math.max(0, until - Date.now()),
    };
  });
}
