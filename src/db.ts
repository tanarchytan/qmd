/**
 * db.ts - Cross-runtime SQLite compatibility layer
 *
 * Provides a unified Database export that works under both Bun (bun:sqlite)
 * and Node.js (better-sqlite3). The APIs are nearly identical — the main
 * difference is the import path.
 *
 * Two init modes:
 * - Normal (CLI, MCP, SDK): top-level await initializes at module load
 * - Plugin (OpenClaw/Jiti): call initDb() explicitly before openDatabase()
 */

export const isBun = typeof globalThis.Bun !== "undefined";

let _Database: any;
let _sqliteVecLoad: ((db: any) => void) | null = null;
let _initialized = false;

async function _doInit(): Promise<void> {
  if (_initialized) return;

  if (isBun) {
    const bunSqlite = "bun:" + "sqlite";
    const BunDatabase = (await import(/* @vite-ignore */ bunSqlite)).Database;

    if (process.platform === "darwin") {
      const homebrewPaths = [
        "/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib",
        "/usr/local/opt/sqlite/lib/libsqlite3.dylib",
      ];
      for (const p of homebrewPaths) {
        try {
          BunDatabase.setCustomSQLite(p);
          break;
        } catch {}
      }
    }

    _Database = BunDatabase;

    try {
      const { getLoadablePath } = await import("sqlite-vec");
      const vecPath = getLoadablePath();
      const testDb = new BunDatabase(":memory:");
      testDb.loadExtension(vecPath);
      testDb.close();
      _sqliteVecLoad = (db: any) => db.loadExtension(vecPath);
    } catch {
      _sqliteVecLoad = null;
    }
  } else {
    _Database = (await import("better-sqlite3")).default;
    try {
      const sqliteVec = await import("sqlite-vec");
      _sqliteVecLoad = (db: any) => sqliteVec.load(db);
    } catch {
      _sqliteVecLoad = null;
    }
  }

  _initialized = true;
}

/**
 * Explicit async init — call this in contexts that don't support top-level await
 * (OpenClaw plugin via Jiti). For normal CLI/MCP/SDK usage, the top-level await
 * below handles it automatically.
 */
export async function initDb(): Promise<void> {
  await _doInit();
}

// Top-level await for normal contexts (CLI, MCP server, SDK, tests).
// This runs at module load time. Jiti/OpenClaw will skip this via the
// plugin's explicit initDb() call.
try {
  await _doInit();
} catch {
  // If top-level await fails (Jiti), caller must use initDb() explicitly
}

/**
 * Open a SQLite database. Works with both bun:sqlite and better-sqlite3.
 */
export function openDatabase(path: string): Database {
  if (!_initialized) {
    throw new Error("Database not initialized — call initDb() first in plugin contexts");
  }
  return new _Database(path) as Database;
}

/**
 * Common subset of the Database interface used throughout QMD.
 */
export interface Database {
  exec(sql: string): void;
  prepare(sql: string): Statement;
  loadExtension(path: string): void;
  close(): void;
}

export interface Statement {
  run(...params: any[]): { changes: number; lastInsertRowid: number | bigint };
  get(...params: any[]): any;
  all(...params: any[]): any[];
}

/**
 * Load the sqlite-vec extension into a database.
 */
export function loadSqliteVec(db: Database): void {
  if (!_sqliteVecLoad) {
    const hint = isBun && process.platform === "darwin"
      ? "On macOS with Bun, install Homebrew SQLite: brew install sqlite\n" +
        "Or install qmd with npm instead: npm install -g @tanarchy/qmd"
      : "Ensure the sqlite-vec native module is installed correctly.";
    throw new Error(`sqlite-vec extension is unavailable. ${hint}`);
  }
  _sqliteVecLoad(db);
}
