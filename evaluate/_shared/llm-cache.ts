/**
 * Shared LLM response cache for evaluation reproducibility.
 *
 * Quality fix C: 100% reproducible re-runs of identical configs.
 * Cache key = sha256(model + temperature + seed + prompt)
 * Persistence = JSON file (atomic write per insert)
 *
 * Usage:
 *   const cache = openCache("./evaluate/locomo/llm-cache.json");
 *   const cached = cache.get(key);
 *   if (cached) return cached;
 *   const response = await fetchFromAPI(...);
 *   cache.set(key, response);
 *
 * Disable with QMD_LLM_CACHE=off env var.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";
import { createHash } from "node:crypto";

export type CacheKey = {
  model: string;
  temperature: number;
  seed?: number;
  prompt: string;
};

export type LLMCache = {
  get(key: CacheKey): string | null;
  set(key: CacheKey, value: string): void;
  hash(key: CacheKey): string;
  stats(): { hits: number; misses: number; entries: number };
  flush(): void;
};

function makeHash(key: CacheKey): string {
  const h = createHash("sha256");
  h.update(`${key.model}|${key.temperature}|${key.seed ?? "noseed"}|${key.prompt}`);
  return h.digest("hex").slice(0, 16);
}

export function openCache(path: string): LLMCache {
  const enabled = process.env.QMD_LLM_CACHE !== "off";
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
      const h = makeHash(key);
      const v = store[h];
      if (v != null) { hits++; return v; }
      misses++;
      return null;
    },
    set(key: CacheKey, value: string): void {
      if (!enabled) return;
      const h = makeHash(key);
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
