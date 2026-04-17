/**
 * cli/db-state.ts — Store/DB singleton and lifecycle, extracted from cli/qmd.ts.
 *
 * Owns the CLI's Store handle and DB path override. Entire CLI uses a single
 * open DB for the process's lifetime; this module is where that invariant
 * lives. Not a general-purpose abstraction — it encodes the CLI's specific
 * bootstrap flow (YAML config → store_collections sync → vec-table dimension
 * handling, etc.).
 *
 * Kept out of `src/store.ts` because those utilities serve both the CLI and
 * the MCP/OpenClaw/SDK entry points, each of which manages its own Store
 * instance with different lifecycle needs.
 */

import { createStore, getDefaultDbPath, syncConfigToDb } from "../store.js";
import { loadConfig } from "../collections.js";
import type { Database } from "../db.js";

let store: ReturnType<typeof createStore> | null = null;
let storeDbPathOverride: string | undefined;

/** Singleton accessor. First call opens the DB + syncs YAML config into
 *  store_collections so the query path reads authoritative state from SQLite.
 *  Missing/malformed YAML is tolerated — a fresh install works fine without it. */
export function getStore(): ReturnType<typeof createStore> {
  if (!store) {
    store = createStore(storeDbPathOverride);
    try {
      const config = loadConfig();
      syncConfigToDb(store.db, config);
    } catch {
      // Config may not exist yet — DB works without it.
    }
  }
  return store;
}

/** Convenience for callers that only need the raw better-sqlite3 Database. */
export function getDb(): Database {
  return getStore().db;
}

/** Re-sync YAML config into SQLite after CLI mutations (add/remove/rename
 *  collection, context changes). Clears the cached config_hash so the next
 *  sync picks up changes even if the file's contents look equivalent. */
export function resyncConfig(): void {
  const s = getStore();
  try {
    const config = loadConfig();
    s.db.prepare(`DELETE FROM store_config WHERE key = 'config_hash'`).run();
    syncConfigToDb(s.db, config);
  } catch {
    // Config may not exist — that's fine.
  }
}

/** Close the open Store and drop the singleton. Safe to call multiple times. */
export function closeDb(): void {
  if (store) {
    store.close();
    store = null;
  }
}

/** Resolved DB path — the override if setIndexName was called, otherwise the
 *  active Store's path, otherwise the default `~/.cache/qmd/index.sqlite`. */
export function getDbPath(): string {
  return store?.dbPath ?? storeDbPathOverride ?? getDefaultDbPath();
}

/** Point the next `getStore()` call at a different index. Path may be either
 *  an index name or a filesystem path; filesystem paths are normalized to a
 *  single-token filename so we don't nest real directories under the cache
 *  dir. Closes the current handle so the next access opens the new index. */
export function setIndexName(name: string | null): void {
  let normalizedName = name;
  if (name && name.includes("/")) {
    const { resolve } = require("path");
    const { cwd } = require("process");
    const absolutePath = resolve(cwd(), name);
    normalizedName = absolutePath.replace(/\//g, "_").replace(/^_/, "");
  }
  storeDbPathOverride = normalizedName ? getDefaultDbPath(normalizedName) : undefined;
  closeDb();
}

/** Idempotent sqlite-vec table creation for the given dimension. Ignores the
 *  `_db` argument because the Store owns the DB; callers sometimes have a
 *  Database handle but we route through the Store so its internal cache stays
 *  consistent. */
export function ensureVecTable(_db: Database, dimensions: number): void {
  getStore().ensureVecTable(dimensions);
}
