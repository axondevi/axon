/**
 * Conversation buffer — debounce inbound WhatsApp messages so multi-bubble
 * inputs are processed as ONE turn.
 *
 * Why this exists:
 * Real users often hit "send" 3 times in 5 seconds — "Oi" → "estou procurando" →
 * "para minha irmã". Without buffering, each webhook fires in parallel:
 *   - All three reads start with the same (empty) history
 *   - The agent answers the FIRST message three times, ignoring 2 and 3
 *   - Result: duplicate "Que bom ter você aqui!" replies, missed context
 *
 * The buffer holds inbound messages per session for `BUFFER_WINDOW_MS`. Every
 * new message resets the timer. When it fires, the flush callback receives
 * ALL buffered messages — to be merged into a single user turn before the
 * LLM call.
 *
 * In-memory only: works for single-instance Render deploys (the current
 * setup). If we scale to multiple replicas, this needs Redis or a Postgres
 * advisory-lock variant — but that's a real problem for later.
 */
import type { InboundMessage } from './evolution';

export interface BufferedMessage {
  inbound: InboundMessage;
  /** Already enriched (vision description / audio transcript replaces media payload). */
  inboundText: string;
  receivedAt: number;
  userSentAudio: boolean;
  /**
   * Optional payload for document-vault persistence. Set by the webhook
   * handler on photo / PDF inbounds AFTER extraction succeeds. Read by
   * processBufferedTurn after contact_memory is loaded — it then fires
   * saveContactDocument fire-and-forget so the bytes + classification
   * land on contact_documents without blocking the agent reply.
   *
   * Bytes are kept in memory during the buffer window (default 3s) — at
   * MAX_BUFFERED=8 messages × ~5MB typical photo, the worst-case footprint
   * per session is ~40MB which is fine for a single-instance Render deploy.
   */
  mediaForVault?: {
    bytes: Uint8Array;
    mimeType: string;
    filename?: string;
    callerCaption?: string;
    extractedText: string;
  };
}

interface ConversationBuffer {
  messages: BufferedMessage[];
  timer: ReturnType<typeof setTimeout> | null;
  /** True while the flush callback is running — new messages queue up. */
  processing: boolean;
}

const buffers = new Map<string, ConversationBuffer>();

/**
 * How long to wait for additional messages before flushing.
 * 3s is the sweet spot from observing real WhatsApp users:
 *   - Long enough that "Oi" + "tudo bem?" arrive together (typical 1-2s gap)
 *   - Short enough that single-message senders don't feel the agent is slow
 */
export const BUFFER_WINDOW_MS = 3000;

/**
 * Hard cap on messages held per session. Prevents memory bloat from a chatty
 * client typing 50 messages while the agent is mid-LLM call. Excess messages
 * still queue but the buffer flushes immediately when the cap is hit.
 */
const MAX_BUFFERED = 8;

export type FlushCallback = (
  sessionKey: string,
  msgs: BufferedMessage[],
) => Promise<void>;

/**
 * Push an inbound message into the buffer. Returns immediately — flush runs
 * asynchronously when the timer expires (or right away if MAX_BUFFERED hit).
 *
 * sessionKey should match the runtime session bucket (e.g. `wa:5511...` for
 * customers, `wa-owner:5511...` for owner mode) so messages from the same
 * conversation merge but different conversations stay isolated.
 */
export function pushToBuffer(
  sessionKey: string,
  msg: BufferedMessage,
  onFlush: FlushCallback,
): void {
  let buf = buffers.get(sessionKey);
  if (!buf) {
    buf = { messages: [], timer: null, processing: false };
    buffers.set(sessionKey, buf);
  }

  buf.messages.push(msg);

  // Hard-cap reached: flush right away, don't wait for the window
  if (buf.messages.length >= MAX_BUFFERED) {
    if (buf.timer) {
      clearTimeout(buf.timer);
      buf.timer = null;
    }
    void scheduleFlush(sessionKey, onFlush, 0);
    return;
  }

  // Reset the debounce timer
  if (buf.timer) clearTimeout(buf.timer);
  buf.timer = setTimeout(() => {
    void scheduleFlush(sessionKey, onFlush, 0);
  }, BUFFER_WINDOW_MS);
}

/**
 * Drain the buffer and run the flush callback. Re-runs if more messages
 * arrived during the previous flush (LLM calls take 2-10s; the user might
 * keep typing). Each re-run starts a fresh debounce window so the agent
 * doesn't reply mid-burst.
 */
async function scheduleFlush(
  sessionKey: string,
  onFlush: FlushCallback,
  delayMs: number,
): Promise<void> {
  if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));

  const buf = buffers.get(sessionKey);
  if (!buf) return;

  // If already processing, the in-flight flush will pick up new messages
  // when it loops at the end. Don't start a parallel flush.
  if (buf.processing) return;
  if (buf.messages.length === 0) return;

  buf.processing = true;
  try {
    while (true) {
      const toProcess = buf.messages.slice();
      buf.messages = [];
      buf.timer = null;

      try {
        await onFlush(sessionKey, toProcess);
      } catch {
        // Callback failures are silent here — the caller is responsible for
        // user-visible error handling. We don't want a thrown error to leave
        // `processing` stuck true and freeze the buffer forever.
      }

      // If new messages arrived during the flush, keep going. But re-debounce:
      // give the user 1.5s extra to finish typing before we reply again.
      if (buf.messages.length === 0) break;
      await new Promise((r) => setTimeout(r, BUFFER_WINDOW_MS / 2));
      if (buf.messages.length === 0) break;
    }
  } finally {
    buf.processing = false;
  }
}

/**
 * Merge buffered messages into a single user-message text.
 *
 * If the user sent multiple separate bubbles ("Oi", "estou procurando",
 * "pra minha irmã"), join them with newlines so the LLM sees the full thought
 * as one turn. Media-enriched messages (Vision / audio transcript) keep their
 * brackets so the LLM knows what kind of input they came from.
 *
 * Single-message buffers return that message verbatim.
 */
export function mergeBufferedText(msgs: BufferedMessage[]): string {
  if (msgs.length === 0) return '';
  if (msgs.length === 1) return msgs[0].inboundText;

  // Multi-message: join with newlines, sorted by received order.
  // This keeps "Oi" → "estou procurando" → "pra minha irmã" readable as one
  // continuous user thought, the way a human reader would scan the bubbles.
  return msgs
    .slice()
    .sort((a, b) => a.receivedAt - b.receivedAt)
    .map((m) => m.inboundText.trim())
    .filter(Boolean)
    .join('\n');
}

/**
 * True if any buffered message in the bunch was an audio voice note.
 * The agent uses this to decide reply mode (voice in → voice out).
 */
export function anyAudio(msgs: BufferedMessage[]): boolean {
  return msgs.some((m) => m.userSentAudio);
}

/**
 * Test helper — clear all in-memory buffers. Production never calls this.
 */
export function _resetBuffers(): void {
  for (const buf of buffers.values()) {
    if (buf.timer) clearTimeout(buf.timer);
  }
  buffers.clear();
}
