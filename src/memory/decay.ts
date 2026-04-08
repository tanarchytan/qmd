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

export function recencyScore(daysSinceCreation: number, importance: number, tier: string): number {
  const baseHL = BASE_HALF_LIFE[tier] ?? 14;
  const beta = BETA[tier] ?? 1.0;
  const effectiveHL = baseHL * Math.exp(MU * importance);
  const lambda = Math.LN2 / effectiveHL;
  return Math.exp(-lambda * Math.pow(Math.max(0, daysSinceCreation), beta));
}

export function frequencyScore(accessCount: number): number {
  return 1 - Math.exp(-accessCount / 5);
}

export function intrinsicScore(importance: number): number {
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

export function evaluateTier(
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
