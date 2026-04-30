/**
 * Tracks message IDs the agent recently sent via Evolution.
 *
 * Why: when Evolution fires a `messages.upsert` webhook with `fromMe=true`,
 * we need to tell two cases apart:
 *   1. Our agent's own send echoing back (Evolution emits the event for
 *      every send, even those WE initiated). Drop silently.
 *   2. The owner picked up their phone and replied manually. This is a
 *      "human handoff" — flip the agent into a quiet mode for that
 *      contact for 30min so the human can take over.
 *
 * Implementation: in-memory Set with TTL eviction. We don't need
 * cross-process consistency — Render free tier runs single replica, and
 * even on multi-replica the worst case is one missed handoff signal
 * (the agent sends an extra reply, then quiets down on the next turn).
 *
 * Capacity is bounded so a runaway loop can't OOM the process.
 */

const MAX_ENTRIES = 5000;
const TTL_MS = 5 * 60 * 1000;  // 5 minutes — well past any webhook delay

interface Entry {
  id: string;
  expiresAt: number;
}

const entries = new Map<string, number>();  // id → expiresAt

function gc(): void {
  if (entries.size <= MAX_ENTRIES) return;
  const now = Date.now();
  for (const [id, expiresAt] of entries) {
    if (expiresAt < now) entries.delete(id);
  }
  // Hard cap fallback if everything's still fresh — drop oldest insertion
  // order (Map preserves insertion order in JS).
  while (entries.size > MAX_ENTRIES) {
    const first = entries.keys().next().value;
    if (!first) break;
    entries.delete(first);
  }
}

export function recordSentId(id: string | undefined | null): void {
  if (!id) return;
  entries.set(id, Date.now() + TTL_MS);
  gc();
}

export function isSentByUs(id: string | undefined | null): boolean {
  if (!id) return false;
  const expiresAt = entries.get(id);
  if (!expiresAt) return false;
  if (expiresAt < Date.now()) {
    entries.delete(id);
    return false;
  }
  return true;
}

// Test helpers (not exported in production paths)
export function _resetForTests(): void { entries.clear(); }
export function _size(): number { return entries.size; }
