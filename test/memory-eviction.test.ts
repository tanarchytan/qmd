/**
 * Quality fix #10: unit test for runEvictionPass.
 * Verifies LRU-K type-weighted eviction logic in src/memory/decay.ts.
 */
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { openDatabase } from "../src/db.js";
import { initializeDatabase } from "../src/store/db-init.js";
import { runEvictionPass } from "../src/memory/decay.js";

const DAY = 86400000;

describe("runEvictionPass", () => {
  let dbPath: string;
  let db: ReturnType<typeof openDatabase>;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "qmd-evict-"));
    dbPath = join(tmpDir, "test.sqlite");
    db = openDatabase(dbPath);
    initializeDatabase(db);
  });

  afterEach(() => {
    try { db.close(); } catch {}
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  // Helper: insert a memory at an arbitrary age (days old)
  const insertAged = (id: string, opts: {
    ageDays: number; importance: number; tier: string; access: number; category?: string;
  }) => {
    const now = Date.now();
    const created = now - opts.ageDays * DAY;
    db.prepare(`
      INSERT INTO memories (id, text, content_hash, category, scope, importance, tier, access_count, created_at, last_accessed)
      VALUES (?, ?, ?, ?, 'global', ?, ?, ?, ?, ?)
    `).run(id, `text-${id}`, id, opts.category || "fact", opts.importance, opts.tier, opts.access, created, created);
  };

  test("dryRun reports candidates without deleting", () => {
    insertAged("old-cold", { ageDays: 60, importance: 0.2, tier: "peripheral", access: 0 });
    const before = (db.prepare("SELECT count(*) as c FROM memories").get() as any).c;

    const r = runEvictionPass(db, { dryRun: true });
    expect(r.evaluated).toBe(1);
    expect(r.evicted).toBe(0);

    const after = (db.prepare("SELECT count(*) as c FROM memories").get() as any).c;
    expect(after).toBe(before);
  });

  test("evicts old, low-importance, cold, peripheral memories", () => {
    insertAged("evictable", { ageDays: 60, importance: 0.2, tier: "peripheral", access: 0 });
    insertAged("recent", { ageDays: 1, importance: 0.2, tier: "peripheral", access: 0 });
    insertAged("important", { ageDays: 60, importance: 0.9, tier: "peripheral", access: 0 });
    insertAged("hot", { ageDays: 60, importance: 0.2, tier: "peripheral", access: 10 });

    const r = runEvictionPass(db);
    expect(r.evicted).toBe(1);
    const ids = db.prepare("SELECT id FROM memories ORDER BY id").all() as { id: string }[];
    expect(ids.map(x => x.id)).toEqual(["hot", "important", "recent"]);
  });

  test("never evicts core tier even when stale", () => {
    insertAged("core-old", { ageDays: 365, importance: 0.1, tier: "core", access: 0 });
    const r = runEvictionPass(db);
    expect(r.evicted).toBe(0);
    expect((db.prepare("SELECT count(*) as c FROM memories").get() as any).c).toBe(1);
  });

  test("never evicts reflection or decision categories", () => {
    insertAged("reflect", { ageDays: 60, importance: 0.2, tier: "peripheral", access: 0, category: "reflection" });
    insertAged("decide", { ageDays: 60, importance: 0.2, tier: "peripheral", access: 0, category: "decision" });
    const r = runEvictionPass(db);
    expect(r.evicted).toBe(0);
  });

  test("logs EVICT action to memory_history", () => {
    insertAged("evictable", { ageDays: 60, importance: 0.2, tier: "peripheral", access: 0 });
    runEvictionPass(db);
    const history = db.prepare("SELECT * FROM memory_history WHERE memory_id = ?").all("evictable") as any[];
    expect(history.length).toBeGreaterThan(0);
    expect(history[0].action).toBe("EVICT");
  });

  test("returns bytesFreed correctly", () => {
    insertAged("evictable", { ageDays: 60, importance: 0.2, tier: "peripheral", access: 0 });
    const r = runEvictionPass(db);
    expect(r.bytesFreed).toBeGreaterThan(0);
    expect(r.bytesFreed).toBe("text-evictable".length);
  });
});
