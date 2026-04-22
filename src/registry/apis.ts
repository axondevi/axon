import { readdirSync, readFileSync, watch, type FSWatcher } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ApiConfig } from './types';

/**
 * Resolve the registry folder relative to THIS source file, not the process
 * cwd. That way the server still works when started from anywhere (IDE run,
 * docker WORKDIR mismatch, worktrees, tests).
 *
 * Override with AXON_REGISTRY_DIR if you want a custom location.
 */
const REGISTRY_DIR =
  process.env.AXON_REGISTRY_DIR ||
  join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'registry');

let cache: Record<string, ApiConfig> | null = null;
let watcher: FSWatcher | null = null;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

export function loadRegistry(force = false): Record<string, ApiConfig> {
  if (cache && !force) return cache;

  const files = readdirSync(REGISTRY_DIR).filter((f) => f.endsWith('.json'));
  const out: Record<string, ApiConfig> = {};

  for (const file of files) {
    try {
      const raw = readFileSync(join(REGISTRY_DIR, file), 'utf8');
      const cfg = JSON.parse(raw) as ApiConfig;
      if (!cfg.slug) {
        console.warn(`[registry] ${file} missing slug — skipped`);
        continue;
      }
      out[cfg.slug] = cfg;
    } catch (err) {
      console.warn(`[registry] failed to parse ${file}:`, (err as Error).message);
    }
  }

  cache = out;
  return out;
}

/**
 * Enable hot-reload of registry JSON files. Watches the folder; on any change
 * we debounce for 200ms then rebuild the cache. Idempotent — safe to call
 * from multiple entry points.
 *
 * Disabled in production (NODE_ENV=production) to avoid surprising behavior.
 */
export function watchRegistry() {
  if (watcher) return;
  if (process.env.NODE_ENV === 'production') {
    console.log('[registry] hot-reload disabled in production');
    return;
  }

  try {
    watcher = watch(REGISTRY_DIR, { persistent: false }, (_event, filename) => {
      if (!filename || !filename.endsWith('.json')) return;
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        const before = cache ? Object.keys(cache).length : 0;
        loadRegistry(true);
        const after = cache ? Object.keys(cache).length : 0;
        console.log(
          `[registry] reloaded (${before} → ${after} APIs) after change to ${filename}`,
        );
      }, 200);
    });
    console.log('[registry] watching for changes in registry/*.json');
  } catch (err) {
    console.warn('[registry] could not start watcher:', (err as Error).message);
  }
}

export function getApi(slug: string): ApiConfig | undefined {
  return loadRegistry()[slug];
}

export function listApis(): ApiConfig[] {
  return Object.values(loadRegistry());
}
