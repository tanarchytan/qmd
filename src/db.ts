/**
 * db.ts - SQLite compatibility layer (Node.js only)
 *
 * Uses better-sqlite3 for database access and sqlite-vec for vector search.
 * Loaded synchronously via createRequire — no top-level await, Jiti-safe.
 */

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// Load better-sqlite3 synchronously (CJS package)
const BetterSqlite3 = require("better-sqlite3");

// Load sqlite-vec synchronously (CJS package, optional)
let _sqliteVecLoad: ((db: any) => void) | null = null;
try {
  const sqliteVec = require("sqlite-vec");
  _sqliteVecLoad = (db: any) => sqliteVec.load(db);
} catch {
  // sqlite-vec is optional — vector search won't work but FTS is fine
  _sqliteVecLoad = null;
}

/**
 * Open a SQLite database.
 */
export function openDatabase(path: string): Database {
  return new BetterSqlite3(path) as Database;
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
    throw new Error(
      "sqlite-vec extension is unavailable. " +
      "Ensure the sqlite-vec native module is installed correctly."
    );
  }
  _sqliteVecLoad(db);
}
