// =============================================================================
// Database initialization
// =============================================================================

import { loadSqliteVec } from "../db.js";
import type { Database } from "../db.js";

function createSqliteVecUnavailableError(reason: string): Error {
  return new Error(
    "sqlite-vec extension is unavailable. " +
    `${reason}. ` +
    "Install Homebrew SQLite so the sqlite-vec extension can be loaded, " +
    "and set BREW_PREFIX if Homebrew is installed in a non-standard location."
  );
}

function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function verifySqliteVecLoaded(db: Database): void {
  try {
    const row = db.prepare(`SELECT vec_version() AS version`).get() as { version?: string } | null;
    if (!row?.version || typeof row.version !== "string") {
      throw new Error("vec_version() returned no version");
    }
  } catch (err) {
    const message = getErrorMessage(err);
    throw createSqliteVecUnavailableError(`sqlite-vec probe failed (${message})`);
  }
}

let _sqliteVecAvailable: boolean | null = null;
// Captured at initialization so ensureVecTableInternal can surface the
// original cause instead of a generic "extension not available" string.
// Upstream tobi/qmd 0adbdeb.
let _sqliteVecUnavailableReason: string | null = null;

export function isSqliteVecAvailable(): boolean {
  return _sqliteVecAvailable === true;
}

export function initializeDatabase(db: Database): void {
  try {
    loadSqliteVec(db);
    verifySqliteVecLoaded(db);
    _sqliteVecAvailable = true;
    _sqliteVecUnavailableReason = null;
  } catch (err) {
    // sqlite-vec is optional -- vector search won't work but FTS is fine
    _sqliteVecAvailable = false;
    _sqliteVecUnavailableReason = getErrorMessage(err);
    console.warn(_sqliteVecUnavailableReason);
  }
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA cache_size = -65536");       // 64MB page cache (default 2MB)
  db.exec("PRAGMA mmap_size = 268435456");     // 256MB memory-mapped I/O
  db.exec("PRAGMA synchronous = NORMAL");      // Safe with WAL, 2-5x faster writes
  db.exec("PRAGMA temp_store = MEMORY");       // Temp tables in RAM
  db.exec("PRAGMA wal_autocheckpoint = 2000"); // Fewer checkpoints during bulk ops

  // Drop legacy tables that are now managed in YAML
  db.exec(`DROP TABLE IF EXISTS path_contexts`);
  db.exec(`DROP TABLE IF EXISTS collections`);

  // Content-addressable storage - the source of truth for document content
  db.exec(`
    CREATE TABLE IF NOT EXISTS content (
      hash TEXT PRIMARY KEY,
      doc TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);

  // Documents table - file system layer mapping virtual paths to content hashes
  // Collections are now managed in ~/.config/qmd/index.yml
  db.exec(`
    CREATE TABLE IF NOT EXISTS documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      collection TEXT NOT NULL,
      path TEXT NOT NULL,
      title TEXT NOT NULL,
      hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      modified_at TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      FOREIGN KEY (hash) REFERENCES content(hash) ON DELETE CASCADE,
      UNIQUE(collection, path)
    )
  `);

  db.exec(`CREATE INDEX IF NOT EXISTS idx_documents_collection ON documents(collection, active)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_documents_hash ON documents(hash)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_documents_path ON documents(path, active)`);

  // Cache table for LLM API calls
  db.exec(`
    CREATE TABLE IF NOT EXISTS llm_cache (
      hash TEXT PRIMARY KEY,
      result TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);

  // Content vectors
  const cvInfo = db.prepare(`PRAGMA table_info(content_vectors)`).all() as { name: string }[];
  const hasSeqColumn = cvInfo.some(col => col.name === 'seq');
  if (cvInfo.length > 0 && !hasSeqColumn) {
    db.exec(`DROP TABLE IF EXISTS content_vectors`);
    db.exec(`DROP TABLE IF EXISTS vectors_vec`);
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS content_vectors (
      hash TEXT NOT NULL,
      seq INTEGER NOT NULL DEFAULT 0,
      pos INTEGER NOT NULL DEFAULT 0,
      model TEXT NOT NULL,
      embedded_at TEXT NOT NULL,
      PRIMARY KEY (hash, seq)
    )
  `);

  // Store collections -- makes the DB self-contained (no external config needed)
  db.exec(`
    CREATE TABLE IF NOT EXISTS store_collections (
      name TEXT PRIMARY KEY,
      path TEXT NOT NULL,
      pattern TEXT NOT NULL DEFAULT '**/*.md',
      ignore_patterns TEXT,
      include_by_default INTEGER DEFAULT 1,
      update_command TEXT,
      context TEXT
    )
  `);

  // Store config -- key-value metadata (e.g. config_hash for sync optimization)
  db.exec(`
    CREATE TABLE IF NOT EXISTS store_config (
      key TEXT PRIMARY KEY,
      value TEXT
    )
  `);

  // FTS - index filepath (collection/path), title, and content
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
      filepath, title, body,
      tokenize='porter unicode61'
    )
  `);

  // Triggers to keep FTS in sync
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS documents_ai AFTER INSERT ON documents
    WHEN new.active = 1
    BEGIN
      INSERT INTO documents_fts(rowid, filepath, title, body)
      SELECT
        new.id,
        new.collection || '/' || new.path,
        new.title,
        (SELECT doc FROM content WHERE hash = new.hash)
      WHERE new.active = 1;
    END
  `);

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS documents_ad AFTER DELETE ON documents BEGIN
      DELETE FROM documents_fts WHERE rowid = old.id;
    END
  `);

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS documents_au AFTER UPDATE ON documents
    BEGIN
      -- Delete from FTS if no longer active
      DELETE FROM documents_fts WHERE rowid = old.id AND new.active = 0;

      -- Update FTS if still/newly active
      INSERT OR REPLACE INTO documents_fts(rowid, filepath, title, body)
      SELECT
        new.id,
        new.collection || '/' || new.path,
        new.title,
        (SELECT doc FROM content WHERE hash = new.hash)
      WHERE new.active = 1;
    END
  `);

  // ==========================================================================
  // Memory tables -- conversation memory for agents
  // ==========================================================================

  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      text TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'other',
      scope TEXT NOT NULL DEFAULT 'global',
      importance REAL NOT NULL DEFAULT 0.5,
      tier TEXT NOT NULL DEFAULT 'peripheral',
      access_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      last_accessed INTEGER,
      metadata TEXT
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_memories_scope ON memories(scope)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_memories_category ON memories(category)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_memories_hash ON memories(content_hash)`);

  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
      text, category, scope,
      tokenize='porter unicode61'
    )
  `);

  // Keep memories_fts in sync
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
      INSERT INTO memories_fts(rowid, text, category, scope)
      VALUES (new.rowid, new.text, new.category, new.scope);
    END
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
      DELETE FROM memories_fts WHERE rowid = old.rowid;
    END
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
      DELETE FROM memories_fts WHERE rowid = old.rowid;
      INSERT INTO memories_fts(rowid, text, category, scope)
      VALUES (new.rowid, new.text, new.category, new.scope);
    END
  `);

  // Memory changelog -- audit trail for memory operations
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      memory_id TEXT NOT NULL,
      action TEXT NOT NULL,
      old_value TEXT,
      new_value TEXT,
      timestamp INTEGER NOT NULL
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_memory_history_mid ON memory_history(memory_id)`);

  // ==========================================================================
  // Knowledge graph -- temporal entity-relationship triples
  // From MemPalace: facts with time validity windows
  // ==========================================================================

  db.exec(`
    CREATE TABLE IF NOT EXISTS knowledge (
      id TEXT PRIMARY KEY,
      subject TEXT NOT NULL,
      predicate TEXT NOT NULL,
      object TEXT NOT NULL,
      valid_from INTEGER,
      valid_until INTEGER,
      confidence REAL NOT NULL DEFAULT 1.0,
      source_memory_id TEXT,
      created_at INTEGER NOT NULL
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_knowledge_subject ON knowledge(subject)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_knowledge_predicate ON knowledge(predicate)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_knowledge_object ON knowledge(object)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_knowledge_valid ON knowledge(valid_from, valid_until)`);
  // Add scope column for multi-agent isolation (migration-safe)
  try { db.exec(`ALTER TABLE knowledge ADD COLUMN scope TEXT NOT NULL DEFAULT 'global'`); } catch {}
  db.exec(`CREATE INDEX IF NOT EXISTS idx_knowledge_scope ON knowledge(scope)`);
}

export function ensureVecTableInternal(db: Database, dimensions: number): void {
  if (!_sqliteVecAvailable) {
    throw createSqliteVecUnavailableError(
      _sqliteVecUnavailableReason ?? "vector operations require a SQLite build with extension loading support"
    );
  }
  const tableInfo = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='vectors_vec'`).get() as { sql: string } | null;
  if (tableInfo) {
    const match = tableInfo.sql.match(/float\[(\d+)\]/);
    const hasHashSeq = tableInfo.sql.includes('hash_seq');
    const hasCosine = tableInfo.sql.includes('distance_metric=cosine');
    const existingDims = match?.[1] ? parseInt(match[1], 10) : null;
    if (existingDims === dimensions && hasHashSeq && hasCosine) return;
    if (existingDims !== null && existingDims !== dimensions) {
      throw new Error(
        `Embedding dimension mismatch: existing vectors are ${existingDims}d but the current model produces ${dimensions}d. ` +
        `Run 'qmd embed -f' to re-embed with the new model.`
      );
    }
    db.exec("DROP TABLE IF EXISTS vectors_vec");
  }
  db.exec(`CREATE VIRTUAL TABLE vectors_vec USING vec0(hash_seq TEXT PRIMARY KEY, embedding float[${dimensions}] distance_metric=cosine)`);
}
