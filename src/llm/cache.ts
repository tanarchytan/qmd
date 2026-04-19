/**
 * Shared LLM response cache for evaluation reproducibility.
 *
 * Quality fix C: 100% reproducible re-runs of identical configs.
 * Cache key (v2): sha256("v2|" + model + "|" + temperature + "|" + seed +
 *                        "|" + max_tokens + "|" + prompt), prefixed "v2-".
 * Legacy key (v1, readable for back-compat): sha256(model + "|" + temperature +
 *                                                  "|" + seed + "|" + prompt).
 * On lookup: try v2 first, fall back to v1 (rejecting empty values so stale
 * thinking-model empties don't shadow fresh calls at a larger max_tokens).
 * On write: always v2.
 * Persistence = JSON file (atomic write per insert)
 *
 * Usage:
 *   const cache = openCache("./evaluate/locomo/llm-cache.json");
 *   const cached = cache.get(key);
 *   if (cached) return cached;
 *   const response = await fetchFromAPI(...);
 *   cache.set(key, response);
 *
 * Disable with LOTL_LLM_CACHE=off env var.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";
import { createHash } from "node:crypto";

export type CacheKey = {
  model: string;
  temperature: number;
  seed?: number;
  /**
   * Optional token budget. Added to the hash so thinking-model empty-content
   * entries cached at a smaller budget don't shadow valid results at a larger
   * budget. When omitted, defaults to "default" string so older callers still
   * work (backward compat with existing cache entries).
   */
  max_tokens?: number;
  prompt: string;
};

export type LLMCache = {
  get(key: CacheKey): string | null;
  set(key: CacheKey, value: string): void;
  hash(key: CacheKey): string;
  stats(): { hits: number; misses: number; entries: number };
  flush(): void;
};

// Legacy hash (pre-2026-04-20): model|temp|seed|prompt. Older entries in
// llm-cache.json are keyed like this — keep readable for backward compat.
function makeHashLegacy(key: CacheKey): string {
  const h = createHash("sha256");
  h.update(`${key.model}|${key.temperature}|${key.seed ?? "noseed"}|${key.prompt}`);
  return h.digest("hex").slice(0, 16);
}

// V2 hash: adds max_tokens. Thinking models (qwen-35B, gemma-e4b) burn their
// whole output budget on reasoning_content before emitting content — a prior
// call with a too-small max_tokens caches empty string; a later call at a
// bigger budget would shadow-match that garbage if max_tokens weren't in the
// key. Version-prefixed so v1 and v2 can't collide. New entries always v2.
function makeHashV2(key: CacheKey): string {
  const h = createHash("sha256");
  h.update(`v2|${key.model}|${key.temperature}|${key.seed ?? "noseed"}|${key.max_tokens ?? "default"}|${key.prompt}`);
  return "v2-" + h.digest("hex").slice(0, 16);
}

// Back-compat export for callers that referenced makeHash directly.
const makeHash = makeHashV2;

export function openCache(path: string): LLMCache {
  const enabled = process.env.LOTL_LLM_CACHE !== "off";
  let store: Record<string, string> = {};
  let hits = 0;
  let misses = 0;
  let pending = false;

  if (enabled && existsSync(path)) {
    try { store = JSON.parse(readFileSync(path, "utf-8")); }
    catch { store = {}; }
  }

  const flush = () => {
    if (!enabled || !pending) return;
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(store, null, 2));
      pending = false;
    } catch (e) {
      process.stderr.write(`[llm-cache] flush failed: ${e}\n`);
    }
  };

  // Periodic flush every 30s in case of crash
  if (enabled) {
    const interval = setInterval(flush, 30000);
    interval.unref();
    process.on("exit", flush);
  }

  return {
    get(key: CacheKey): string | null {
      if (!enabled) return null;
      // Try v2 first (new entries with max_tokens in the hash).
      const hV2 = makeHashV2(key);
      const vV2 = store[hV2];
      if (vV2 != null) { hits++; return vV2; }
      // Fall back to legacy hash for entries written before the v2 migration.
      // Reject empty legacy values so stale gemma/qwen empty-content entries
      // (thinking-model budget exhaustion bug) don't shadow-match a fresh call
      // at a larger max_tokens. Treats empty as miss → regenerate → cache v2.
      const hLegacy = makeHashLegacy(key);
      const vLegacy = store[hLegacy];
      if (vLegacy != null && vLegacy.trim().length > 0) { hits++; return vLegacy; }
      misses++;
      return null;
    },
    set(key: CacheKey, value: string): void {
      if (!enabled) return;
      // Always write to v2. Legacy entries stay in place and readable via the
      // fallback path above; they'll age out naturally as runs regenerate.
      const h = makeHashV2(key);
      store[h] = value;
      pending = true;
      // Flush every 10 inserts to balance safety and speed
      if (Object.keys(store).length % 10 === 0) flush();
    },
    hash: makeHash,
    stats(): { hits: number; misses: number; entries: number } {
      return { hits, misses, entries: Object.keys(store).length };
    },
    flush,
  };
}
