/**
 * silent-fallback-warnings.test.ts — smoke tests for the silent-degradation
 * stderr warnings in src/store/search.ts.
 *
 * These warnings cover three documented "graceful-degradation" paths where
 * an optional pipeline stage no-ops because no backend is configured:
 *   - getEmbedding → vector search disabled
 *   - expandQuery → raw query only
 *   - rerank → uncached docs land at the bottom
 *
 * Without the warnings, missing-backend conditions look like "search just
 * returns fewer results" with no signal that a stage was skipped. The
 * warnings dedupe per-process via a module-scoped Set, and can be suppressed
 * via LOTL_QUIET_FALLBACK=1 (used by the eval harness, which configures
 * no-backend mode intentionally).
 *
 * Tests use vi.spyOn(process.stderr, "write") since the warning helper is
 * module-private — they assert via stderr capture rather than spying on the
 * helper directly.
 */

import type { MockInstance } from "vitest";
import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";

let stderrSpy: MockInstance<typeof process.stderr.write>;

beforeEach(() => {
  // Each describe block resets the module's _fallbackWarned dedupe Set
  // by re-importing — see the dynamic import inside each test below.
  delete process.env.LOTL_QUIET_FALLBACK;
  delete process.env.LOTL_RERANK_PROVIDER;
  delete process.env.LOTL_QUERY_EXPANSION_PROVIDER;
  delete process.env.LOTL_EMBED_PROVIDER;
  // Reset the cached remote config so env changes take effect.
  // (remote-config caches the result of getRemoteConfig() singleton-style.)
});

afterEach(() => {
  stderrSpy?.mockRestore();
});

describe("silent-fallback warnings", () => {
  test("rerank warns once when no remote rerank and no llmOverride", async () => {
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    // Fresh module load via dynamic import to reset _fallbackWarned dedupe
    vi.resetModules();
    const { rerank: rerankFresh } = await import("../src/store/search.js");

    const docs = [{ file: "a", text: "doc one" }, { file: "b", text: "doc two" }];
    const result = await rerankFresh("test query", docs);

    expect(result).toHaveLength(2);
    // Both docs get score 0 (no rerank, no cache, no override)
    expect(result.every(r => r.score === 0)).toBe(true);

    const warnings = stderrSpy.mock.calls.flat().filter(
      (s): s is string => typeof s === "string" && s.includes("rerank disabled"),
    );
    expect(warnings.length).toBeGreaterThanOrEqual(1);
    expect(warnings[0]).toContain("LOTL_RERANK_PROVIDER");
  });

  test("rerank dedupes — only one warning across multiple calls", async () => {
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    vi.resetModules();
    const { rerank: rerankFresh } = await import("../src/store/search.js");

    const docs = [{ file: "a", text: "x" }];
    await rerankFresh("q1", docs);
    await rerankFresh("q2", docs);
    await rerankFresh("q3", docs);

    const warnings = stderrSpy.mock.calls.flat().filter(
      (s): s is string => typeof s === "string" && s.includes("rerank disabled"),
    );
    expect(warnings).toHaveLength(1);
  });

  test("LOTL_QUIET_FALLBACK=1 suppresses warnings", async () => {
    process.env.LOTL_QUIET_FALLBACK = "1";
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    vi.resetModules();
    const { rerank: rerankFresh } = await import("../src/store/search.js");

    await rerankFresh("q", [{ file: "a", text: "x" }]);

    const warnings = stderrSpy.mock.calls.flat().filter(
      (s): s is string => typeof s === "string" && s.includes("[lotl]"),
    );
    expect(warnings).toHaveLength(0);
  });

  test("expandQuery warns once when no remote queryExpansion and no llmOverride", async () => {
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    vi.resetModules();
    const { expandQuery: expandFresh } = await import("../src/store/search.js");
    const { openDatabase } = await import("../src/db.js");
    const { initializeDatabase } = await import("../src/store/db-init.js");

    // expandQuery needs a Database for cache lookups
    const db = openDatabase(":memory:");
    initializeDatabase(db);

    const result = await expandFresh("test query", undefined, db);
    expect(result).toEqual([]);

    const warnings = stderrSpy.mock.calls.flat().filter(
      (s): s is string => typeof s === "string" && s.includes("query expansion disabled"),
    );
    expect(warnings.length).toBeGreaterThanOrEqual(1);
    expect(warnings[0]).toContain("LOTL_QUERY_EXPANSION_PROVIDER");
    db.close();
  });
});
