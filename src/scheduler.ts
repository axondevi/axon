/**
 * Axon background scheduler.
 *
 * A thin process that runs recurring jobs. Spawn it separately from the
 * main API server (e.g., on Railway as a "worker" service pointed at this
 * entry point, or via an external cron that hits specific admin endpoints).
 *
 * Run locally:
 *   bun run src/scheduler.ts
 *
 * Run on Railway as a separate service:
 *   start command: bun run src/scheduler.ts
 *
 * Alternative: don't run this at all; instead trigger the admin endpoint
 * from an external cron (GitHub Actions, cron-job.org, etc.):
 *   curl -X POST https://api.axon.dev/v1/admin/settlements/run \
 *     -H "x-admin-key: $ADMIN_API_KEY"
 *
 * The two approaches are equivalent. The scheduler just keeps the cron
 * in-process.
 */

import { settleAll, yesterdayUTC } from '~/settlement';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Returns the next occurrence of the given UTC HH:MM from now. */
function nextAt(hour: number, minute: number): Date {
  const now = new Date();
  const next = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      hour,
      minute,
      0,
      0,
    ),
  );
  if (next <= now) next.setTime(next.getTime() + DAY_MS);
  return next;
}

async function runSettlementJob() {
  const period = yesterdayUTC();
  console.log(
    `[scheduler] settlement run for ${period.start.toISOString()} → ${period.end.toISOString()}`,
  );
  try {
    const results = await settleAll(period);
    const summary = results.map(
      (r) => `${r.slug}: ${r.requests} req, ${r.owedMicro.toString()} µUSDC`,
    );
    console.log('[scheduler] settlement complete:\n  ' + summary.join('\n  '));
  } catch (err) {
    console.error('[scheduler] settlement failed:', err);
  }
}

function scheduleDaily(
  name: string,
  hour: number,
  minute: number,
  job: () => Promise<void>,
) {
  const tick = () => {
    const next = nextAt(hour, minute);
    const delayMs = next.getTime() - Date.now();
    console.log(
      `[scheduler] ${name}: next run at ${next.toISOString()} (in ${Math.round(delayMs / 60000)}m)`,
    );
    setTimeout(async () => {
      try {
        await job();
      } finally {
        tick();
      }
    }, delayMs);
  };
  tick();
}

async function main() {
  console.log('[scheduler] starting');

  // Daily settlement at 02:00 UTC
  scheduleDaily('settlement', 2, 0, runSettlementJob);

  // Run once on boot if env asks for it (useful for one-shot cron workers)
  if (process.env.RUN_ON_BOOT === 'true') {
    console.log('[scheduler] RUN_ON_BOOT=true — running settlement now');
    await runSettlementJob();
    if (process.env.EXIT_AFTER_BOOT === 'true') {
      console.log('[scheduler] EXIT_AFTER_BOOT=true — done, exiting');
      process.exit(0);
    }
  }

  // Graceful shutdown
  const shutdown = (signal: string) => {
    console.log(`[scheduler] received ${signal} — shutting down`);
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Keep the process alive
  process.stdin.resume();
}

main().catch((err) => {
  console.error('[scheduler] fatal:', err);
  process.exit(1);
});
