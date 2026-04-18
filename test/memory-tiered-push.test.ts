/**
 * Unit tests for memoryRecallTiered and memoryPushPack.
 * Both are production API surfaces (not wired into LongMemEval eval harness).
 */
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { openDatabase } from "../src/db.js";
import { initializeDatabase } from "../src/store/db-init.js";
import { memoryRecallTiered, memoryPushPack } from "../src/memory/index.js";

const DAY = 86400000;

describe("memoryRecallTiered", () => {
  let dbPath: string;
  let db: ReturnType<typeof openDatabase>;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "qmd-tiered-"));
    dbPath = join(tmpDir, "test.sqlite");
    db = openDatabase(dbPath);
    initializeDatabase(db);
  });

  afterEach(() => {
    try { db.close(); } catch {}
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  const insert = (id: string, tier: string, text: string) => {
    const now = Date.now();
    db.prepare(`
      INSERT INTO memories (id, text, content_hash, category, scope, importance, tier, access_count, created_at, last_accessed)
      VALUES (?, ?, ?, 'fact', 'global', 0.5, ?, 0, ?, ?)
    `).run(id, text, id, tier, now, now);
    // FTS5 is kept in sync via trigger (memories_ai) — no manual insert needed
  };

  test("returns memories grouped by tier", async () => {
    insert("c1", "core", "core memory about pasta");
    insert("w1", "working", "working memory about pasta");
    insert("p1", "peripheral", "peripheral memory about pasta");

    const result = await memoryRecallTiered(db, {
      query: "pasta",
      scope: "global",
      perTierLimit: 5,
    });

    expect(result.core.length).toBe(1);
    expect(result.working.length).toBe(1);
    expect(result.peripheral.length).toBe(1);
    expect(result.core[0]!.id).toBe("c1");
    expect(result.working[0]!.id).toBe("w1");
    expect(result.peripheral[0]!.id).toBe("p1");
  });

  test("respects perTierLimit", async () => {
    for (let i = 0; i < 10; i++) insert(`c${i}`, "core", `core mem ${i} dinner`);
    const result = await memoryRecallTiered(db, {
      query: "dinner",
      scope: "global",
      perTierLimit: 3,
    });
    expect(result.core.length).toBeLessThanOrEqual(3);
  });

  test("empty tiers return empty arrays", async () => {
    insert("c1", "core", "only core pasta");
    const result = await memoryRecallTiered(db, {
      query: "pasta",
      scope: "global",
    });
    expect(result.core.length).toBe(1);
    expect(result.working).toEqual([]);
    expect(result.peripheral).toEqual([]);
  });
});

describe("memoryPushPack", () => {
  let dbPath: string;
  let db: ReturnType<typeof openDatabase>;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "qmd-push-"));
    dbPath = join(tmpDir, "test.sqlite");
    db = openDatabase(dbPath);
    initializeDatabase(db);
  });

  afterEach(() => {
    try { db.close(); } catch {}
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  const insert = (id: string, opts: {
    tier: string; importance: number; ageDays?: number; accessDaysAgo?: number;
  }) => {
    const now = Date.now();
    const created = now - (opts.ageDays ?? 0) * DAY;
    const lastAccessed = opts.accessDaysAgo !== undefined
      ? now - opts.accessDaysAgo * DAY
      : null;
    db.prepare(`
      INSERT INTO memories (id, text, content_hash, category, scope, importance, tier, access_count, created_at, last_accessed)
      VALUES (?, ?, ?, 'fact', 'global', ?, ?, 0, ?, ?)
    `).run(id, `text-${id}`, id, opts.importance, opts.tier, created, lastAccessed);
  };

  test("includes core tier always", () => {
    insert("c1", { tier: "core", importance: 0.9 });
    insert("c2", { tier: "core", importance: 0.8 });
    const pack = memoryPushPack(db, { scope: "global", maxEntries: 10 });
    const coreIds = pack.filter(p => p.reason === "core").map(p => p.id);
    expect(coreIds).toContain("c1");
    expect(coreIds).toContain("c2");
  });

  test("includes recent high-importance working/peripheral", () => {
    insert("w1", { tier: "working", importance: 0.8, ageDays: 3 });
    insert("w2", { tier: "working", importance: 0.4, ageDays: 3 });  // below min
    insert("w3", { tier: "working", importance: 0.8, ageDays: 30 }); // too old
    const pack = memoryPushPack(db, { scope: "global", minImportance: 0.7, windowDays: 14 });
    const importantIds = pack.filter(p => p.reason === "important-recent").map(p => p.id);
    expect(importantIds).toContain("w1");
    expect(importantIds).not.toContain("w2");
    expect(importantIds).not.toContain("w3");
  });

  test("includes hot-tail recently accessed", () => {
    insert("h1", { tier: "peripheral", importance: 0.2, accessDaysAgo: 1 });
    insert("h2", { tier: "peripheral", importance: 0.2, accessDaysAgo: 30 }); // too old
    const pack = memoryPushPack(db, { scope: "global", windowDays: 14 });
    const hotIds = pack.filter(p => p.reason === "hot-tail").map(p => p.id);
    expect(hotIds).toContain("h1");
    expect(hotIds).not.toContain("h2");
  });

  test("respects maxEntries cap", () => {
    for (let i = 0; i < 20; i++) insert(`c${i}`, { tier: "core", importance: 0.9 });
    const pack = memoryPushPack(db, { scope: "global", maxEntries: 5 });
    expect(pack.length).toBeLessThanOrEqual(5);
  });

  test("deduplicates across categories", () => {
    // Same memory qualifies for multiple categories
    insert("multi", { tier: "core", importance: 0.9, accessDaysAgo: 1 });
    const pack = memoryPushPack(db, { scope: "global" });
    const multiEntries = pack.filter(p => p.id === "multi");
    expect(multiEntries.length).toBe(1);
    // Core takes precedence (first pushed)
    expect(multiEntries[0]!.reason).toBe("core");
  });
});
