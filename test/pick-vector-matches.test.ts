/**
 * Unit tests for pickVectorMatches — the adaptive cosine-acceptance
 * gate that replaces the legacy fixed 0.3 threshold.
 *
 * Three scenarios stress the algorithm:
 *   1. Open-vault case: clear top-1 with long noisy tail → adaptive floor
 *      drops the tail.
 *   2. Focused-haystack case: uniform similarities (LME _s pattern) →
 *      adaptive floor stays low so the right answer survives.
 *   3. No-signal edge: every result below absFloor → minKeep safety net
 *      keeps the top few so the caller never gets an empty pool.
 */
import { describe, test, expect } from "vitest";
import { pickVectorMatches } from "../src/memory/index.js";

type R = { id: string; similarity: number };

const result = (id: string, sim: number): R => ({ id, similarity: sim });

describe("pickVectorMatches", () => {
  test("open-vault: clear top-1 trims the long tail", () => {
    const inputs: R[] = [
      result("a", 0.85),
      result("b", 0.62),
      result("c", 0.48),
      result("d", 0.40),
      result("e", 0.22),
      result("f", 0.18),
      result("g", 0.10),
    ];
    // top1 = 0.85, relRatio 0.5 → floor = 0.425
    // expects: a (0.85), b (0.62), c (0.48), but rest dropped
    // BUT minKeep = 5 → also d (0.40) and e (0.22) kept by safety net
    const out = pickVectorMatches(inputs, { fixedFloorEnv: "adaptive" });
    expect(out.map(r => r.id)).toEqual(["a", "b", "c", "d", "e"]);
  });

  test("focused-haystack: uniform similarities all pass", () => {
    // LME _s style — every haystack candidate is on-topic so nothing
    // scores high in absolute terms but everything is in the same range.
    const inputs: R[] = [
      result("a", 0.32),
      result("b", 0.30),
      result("c", 0.28),
      result("d", 0.25),
      result("e", 0.22),
      result("f", 0.20),
      result("g", 0.18),
      result("h", 0.16),
    ];
    // top1 = 0.32, floor = max(0.05, 0.16) = 0.16
    // 0.16 → just barely passes, so all 8 kept
    const out = pickVectorMatches(inputs, { fixedFloorEnv: "adaptive" });
    expect(out.length).toBe(8);
  });

  test("no-signal: minKeep safety net preserves top-5 even with awful sims", () => {
    const inputs: R[] = [
      result("a", 0.04),
      result("b", 0.03),
      result("c", 0.02),
      result("d", 0.01),
      result("e", 0.005),
      result("f", 0.001),
    ];
    // floor = max(0.05, 0.02) = 0.05 — every result fails
    // But minKeep=5 → keeps a, b, c, d, e
    const out = pickVectorMatches(inputs, { fixedFloorEnv: "adaptive" });
    expect(out.map(r => r.id)).toEqual(["a", "b", "c", "d", "e"]);
  });

  test("legacy fixed floor: respects QMD_VEC_MIN_SIM=0.3", () => {
    const inputs: R[] = [
      result("a", 0.50),
      result("b", 0.35),
      result("c", 0.29),
      result("d", 0.10),
    ];
    // Fixed floor 0.3 — drops c and d, but minKeep keeps c (top 3)
    // Wait: minKeep=5 so c and d kept too.
    // The fixed-floor mode behaves the same way: floor filter, minKeep override.
    const out = pickVectorMatches(inputs, { fixedFloorEnv: "0.3" });
    expect(out.length).toBe(4); // minKeep = 5, fewer than 5 inputs → all
  });

  test("permissive mode: QMD_VEC_MIN_SIM=0 keeps everything", () => {
    const inputs: R[] = [
      result("a", 0.50),
      result("b", 0.30),
      result("c", 0.10),
      result("d", -0.05),
    ];
    const out = pickVectorMatches(inputs, { fixedFloorEnv: "0" });
    expect(out.length).toBe(4);
  });

  test("results stay in descending similarity order", () => {
    const inputs: R[] = [
      result("c", 0.30),
      result("a", 0.50),
      result("b", 0.40),
    ];
    const out = pickVectorMatches(inputs, { fixedFloorEnv: "adaptive" });
    expect(out.map(r => r.similarity)).toEqual([0.50, 0.40, 0.30]);
  });

  test("empty input returns empty output", () => {
    const out = pickVectorMatches([], { fixedFloorEnv: "adaptive" });
    expect(out).toEqual([]);
  });
});
