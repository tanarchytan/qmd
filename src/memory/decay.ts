/**
 * memory/decay.ts — Weibull decay engine + tier promotion for memories.
 *
 * Ported from memory-lancedb-pro. Memories decay over time unless accessed
 * frequently or marked important. Three tiers: Peripheral → Working → Core.
 *
 * Composite score = 0.4 * recency + 0.3 * frequency + 0.3 * intrinsic
 */

import type { Database } from "../db.js";

// =============================================================================
// Constants
// =============================================================================

const BASE_HALF_LIFE: Record<string, number> = {
  peripheral: 14,
  working: 30,
  core: 90,
};

const BETA: Record<string, number> = {
  peripheral: 1.3,
  working: 1.0,
  core: 0.8,
};

const DECAY_FLOOR: Record<string, number> = {
  peripheral: 0.5,
  working: 0.7,
  core: 0.9,
};

const MU = 1.5;
const STALE_THRESHOLD = 0.3;

// =============================================================================
// Scoring functions
// =============================================================================

function recencyScore(daysSinceCreation: number, importance: number, tier: string): number {
  const baseHL = BASE_HALF_LIFE[tier] ?? 14;
  const beta = BETA[tier] ?? 1.0;
  const effectiveHL = baseHL * Math.exp(MU * importance);
  const lambda = Math.LN2 / effectiveHL;
  return Math.exp(-lambda * Math.pow(Math.max(0, daysSinceCreation), beta));
}

function frequencyScore(accessCount: number): number {
  return 1 - Math.exp(-accessCount / 5);
}

function intrinsicScore(importance: number): number {
  return Math.max(0, Math.min(1, importance));
}

export function compositeScore(
  daysSinceCreation: number, accessCount: number, importance: number, tier: string
): number {
  const recency = recencyScore(daysSinceCreation, importance, tier);
  const frequency = frequencyScore(accessCount);
  const intrinsic = intrinsicScore(importance);
  const raw = 0.4 * recency + 0.3 * frequency + 0.3 * intrinsic;
  const floor = DECAY_FLOOR[tier] ?? 0;
  return Math.max(raw, floor * intrinsic);
}

// =============================================================================
// Tier promotion / demotion
// =============================================================================

export type TierChange = { id: string; oldTier: string; newTier: string; composite: number };

function evaluateTier(
  currentTier: string, accessCount: number, composite: number, importance: number
): string | null {
  if (currentTier === "peripheral") {
    if (accessCount >= 3 && composite >= 0.4) return "working";
  } else if (currentTier === "working") {
    if (accessCount >= 10 && composite >= 0.7 && importance >= 0.8) return "core";
    if (composite < 0.15) return "peripheral";
  } else if (currentTier === "core") {
    if (composite < 0.15 && accessCount < 3) return "working";
  }
  return null;
}

// =============================================================================
// Run decay pass
// =============================================================================

export type DecayResult = {
  processed: number; promoted: number; demoted: number; stale: number; changes: TierChange[];
};

export function runDecayPass(db: Database): DecayResult {
  const now = Date.now();
  const MS_PER_DAY = 86400000;
  const memories = db.prepare(
    `SELECT id, importance, tier, access_count, created_at FROM memories`
  ).all() as { id: string; importance: number; tier: string; access_count: number; created_at: number }[];

  let promoted = 0, demoted = 0, stale = 0;
  const changes: TierChange[] = [];
  const updateTier = db.prepare(`UPDATE memories SET tier = ? WHERE id = ?`);

  for (const mem of memories) {
    const daysSince = (now - mem.created_at) / MS_PER_DAY;
    const score = compositeScore(daysSince, mem.access_count, mem.importance, mem.tier);
    if (score < STALE_THRESHOLD) stale++;

    const newTier = evaluateTier(mem.tier, mem.access_count, score, mem.importance);
    if (newTier) {
      updateTier.run(newTier, mem.id);
      changes.push({ id: mem.id, oldTier: mem.tier, newTier, composite: score });
      if ((mem.tier === "peripheral" && newTier === "working") || (mem.tier === "working" && newTier === "core")) {
        promoted++;
      } else {
        demoted++;
      }
    }
  }

  return { processed: memories.length, promoted, demoted, stale, changes };
}

export function getDecayScore(
  createdAt: number, accessCount: number, importance: number, tier: string
): number {
  const daysSince = (Date.now() - createdAt) / 86400000;
  return compositeScore(daysSince, accessCount, importance, tier);
}

// =============================================================================
// Eviction (cat 17 — LRU-K, O'Neil 1993; type-weighted from Total Recall)
// =============================================================================

export type EvictionOptions = {
  /** Memories older than this are eviction candidates. Default 30 days. */
  maxAgeDays?: number;
  /** Importance threshold below which memories are evictable. Default 0.4. */
  minImportance?: number;
  /** Memories with at least this access count are spared. Default 2. */
  minAccessCount?: number;
  /**
   * Backward-K window for the LRU-K sparing check: memories whose
   * last_accessed falls within this window are treated as hot and
   * exempted from eviction, regardless of creation age. Default 7 days.
   * (True LRU-K would track the K-th most recent access; a single-field
   * window is the best we can do without a per-memory access history.)
   */
  lruWindowDays?: number;
  /** Don't actually delete, just report. */
  dryRun?: boolean;
};

export type EvictionResult = {
  evaluated: number;
  evicted: number;
  preserved: number;
  bytesFreed: number;
};

/**
 * LRU-K type-weighted eviction.
 *
 * Evicts cold low-value memories. Type weighting:
 *   - tier=core         → never evicted
 *   - tier=working      → evicted only if very stale (composite < 0.1)
 *   - tier=peripheral   → evicted if old + low importance + cold
 *   - reflection/decision categories → spared (carry meta-knowledge)
 *
 * From: LRU-K (O'Neil et al. 1993, SIGMOD), Total Recall type-weighted eviction.
 *
 * Run periodically (cron / dream consolidation), NOT during eval — eviction
 * during ingest would defeat dedup. Skip during LoCoMo by passing dryRun.
 */
export function runEvictionPass(db: Database, options: EvictionOptions = {}): EvictionResult {
  const maxAge = (options.maxAgeDays ?? 30) * 86400000;
  const minImp = options.minImportance ?? 0.4;
  const minAccess = options.minAccessCount ?? 2;
  const now = Date.now();
  const cutoff = now - maxAge;

  // Backward-K heuristic cutoff: even candidates that pass the creation-age
  // gate are spared if they were accessed recently (closer to LRU-K semantics
  // than pure created_at scoring). Default: 7 days since last access.
  const lruWindowMs = (options.lruWindowDays ?? 7) * 86400000;
  const lruCutoff = now - lruWindowMs;

  // Find candidates: old, low importance, low access, not core, not protected category
  const candidates = db.prepare(`
    SELECT id, text, importance, access_count, last_accessed, created_at, tier, category
    FROM memories
    WHERE created_at < ?
      AND importance < ?
      AND access_count < ?
      AND tier != 'core'
      AND category != 'reflection'
      AND category != 'decision'
  `).all(cutoff, minImp, minAccess) as Array<{
    id: string; text: string; importance: number; access_count: number;
    last_accessed: number | null; created_at: number; tier: string; category: string;
  }>;

  if (options.dryRun) {
    const bytes = candidates.reduce((s, c) => s + c.text.length, 0);
    return { evaluated: candidates.length, evicted: 0, preserved: candidates.length, bytesFreed: bytes };
  }

  let evicted = 0;
  let bytesFreed = 0;
  const delMem = db.prepare(`DELETE FROM memories WHERE id = ?`);
  // memories_vec is created lazily on first vector insert; tolerate its absence
  let delVec: ReturnType<typeof db.prepare> | null = null;
  try { delVec = db.prepare(`DELETE FROM memories_vec WHERE id = ?`); } catch { /* table not yet created */ }
  const log = db.prepare(`INSERT INTO memory_history (memory_id, action, old_value, timestamp) VALUES (?, 'EVICT', ?, ?)`);

  // Use better-sqlite3 nestable transaction API (item #11) — safer than raw BEGIN/COMMIT
  const txn = db.transaction((cs: typeof candidates) => {
    for (const c of cs) {
      // Backward-K sparing: an item accessed within lruWindowDays is
      // considered hot and exempted from eviction even if creation-old.
      // Closer to LRU-K semantics than scoring purely on creation age,
      // without requiring a per-memory access-timestamp history table.
      if (c.last_accessed !== null && c.last_accessed >= lruCutoff) {
        continue;
      }

      // Working tier needs an extra check — only evict if very stale.
      // Uses last-access age when available (true recency), falling back
      // to creation age for never-accessed memories. This is the
      // behavioral change from pre-LRU-K: a memory created 60 days ago
      // but accessed last week is no longer eligible for eviction on the
      // "60 days stale" grounds.
      if (c.tier === "working") {
        const referenceMs = c.last_accessed ?? c.created_at;
        const days = (now - referenceMs) / 86400000;
        const score = compositeScore(days, c.access_count, c.importance, c.tier);
        if (score >= 0.1) continue;
      }
      log.run(c.id, c.text, now);
      delMem.run(c.id);
      if (delVec) { try { delVec.run(c.id); } catch { /* skip individual vec failures */ } }
      evicted++;
      bytesFreed += c.text.length;
    }
  });
  txn(candidates);

  return { evaluated: candidates.length, evicted, preserved: candidates.length - evicted, bytesFreed };
}
