/**
 * QMD Provider for MemoryBench
 *
 * One tsx process per batch operation. Simple, reliable.
 * Cold-start once per ingest/search call, not per session.
 */

import type {
  Provider,
  ProviderConfig,
  IngestOptions,
  IngestResult,
  SearchOptions,
  IndexingProgressCallback,
} from "../../types/provider";
import type { ProviderPrompts } from "../../types/prompts";
import type { ConcurrencyConfig } from "../../types/concurrency";
import type { UnifiedSession } from "../../types/unified";
import { logger } from "../../utils/logger";

import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const QMD_DIR = process.env.QMD_PROJECT_DIR;
if (!QMD_DIR) {
  throw new Error("QMD_PROJECT_DIR env var required");
}

const tsxBin = (() => {
  const ext = process.platform === "win32" ? ".cmd" : "";
  return join(QMD_DIR, "node_modules", ".bin", "tsx" + ext);
})();

// Worker script — reads commands from input file, writes results to output file
// Processes ALL commands in one process invocation (batch mode)
const WORKER_SCRIPT = `
import { readFileSync, writeFileSync } from "fs";
import { pathToFileURL } from "url";

const QMD_DIR = ${JSON.stringify(QMD_DIR)};
function toUrl(p) { return pathToFileURL(p).href; }

const { loadQmdEnv } = await import(toUrl(QMD_DIR + "/src/env.ts"));
loadQmdEnv();

const { openDatabase } = await import(toUrl(QMD_DIR + "/src/db.ts"));
const { initializeDatabase } = await import(toUrl(QMD_DIR + "/src/store/db-init.ts"));
const { memoryStore, memoryRecall, extractAndStore } =
  await import(toUrl(QMD_DIR + "/src/memory/index.ts"));

const dbCache = new Map();
function getDb(dbPath) {
  let db = dbCache.get(dbPath);
  if (db) return db;
  db = openDatabase(dbPath);
  initializeDatabase(db);
  dbCache.set(dbPath, db);
  return db;
}

const inputFile = process.argv[2];
const outputFile = process.argv[3];
const commands = JSON.parse(readFileSync(inputFile, "utf-8"));
const results = [];

for (const cmd of commands) {
  try {
    const db = getDb(cmd.dbPath);
    switch (cmd.op) {
      case "store": {
        const r = await memoryStore(db, { text: cmd.text, scope: cmd.scope });
        results.push({ ok: true, memId: r.id, status: r.status });
        break;
      }
      case "extract": {
        const r = await extractAndStore(db, cmd.text, cmd.scope);
        results.push({ ok: true, extracted: r.extracted.map(m => ({ id: m.id })), stored: r.stored });
        break;
      }
      case "recall": {
        const r = await memoryRecall(db, { query: cmd.query, limit: cmd.limit || 30, scope: cmd.scope });
        results.push({ ok: true, results: r.map(m => ({ id: m.id, text: m.text, score: m.score, category: m.category, created_at: m.created_at })) });
        break;
      }
      default:
        results.push({ ok: false, error: "Unknown op: " + cmd.op });
    }
  } catch (e) {
    results.push({ ok: false, error: String(e) });
  }
}

// Close all DBs
for (const db of dbCache.values()) db.close();

writeFileSync(outputFile, JSON.stringify(results));
`;

let scriptPath: string | null = null;
function getScriptPath(): string {
  if (!scriptPath) {
    const dir = mkdtempSync(join(tmpdir(), "qmd-worker-"));
    scriptPath = join(dir, "worker.mts");
    writeFileSync(scriptPath, WORKER_SCRIPT);
  }
  return scriptPath;
}

/** Run a batch of commands in one tsx process */
async function runBatch(commands: Record<string, unknown>[]): Promise<any[]> {
  const id = Math.random().toString(36).slice(2, 8);
  const inputFile = join(tmpdir(), `qmd-in-${id}.json`);
  const outputFile = join(tmpdir(), `qmd-out-${id}.json`);

  writeFileSync(inputFile, JSON.stringify(commands));

  const proc = Bun.spawn([tsxBin, getScriptPath(), inputFile, outputFile], {
    cwd: QMD_DIR,
    env: { ...process.env, QMD_LOCAL: "no" },
    stdout: "inherit",
    stderr: "inherit",
  });

  const exitCode = await proc.exited;

  let results: any[];
  try {
    results = JSON.parse(readFileSync(outputFile, "utf-8"));
  } catch {
    throw new Error(`Worker exit ${exitCode}, no output`);
  }

  try { rmSync(inputFile, { force: true }); } catch {}
  try { rmSync(outputFile, { force: true }); } catch {}

  return results;
}

// =============================================================================
// QMD Provider
// =============================================================================

export class QmdProvider implements Provider {
  name = "qmd";
  concurrency: ConcurrencyConfig = { default: 1, search: 5 };

  prompts: ProviderPrompts = {
    answerPrompt: (question: string, context: unknown[], questionDate?: string) => {
      const memories = (context as Array<{ text?: string }>)
        .map((m, i) => `[${i + 1}] ${m.text ?? JSON.stringify(m)}`)
        .join("\n");
      return [
        "You are answering questions about a person based on their memories.",
        "Use ONLY the retrieved memories below. If the answer is not in the memories, say so.",
        questionDate ? `Current date: ${questionDate}` : "",
        "", "Retrieved memories:", memories, "",
        `Question: ${question}`, "", "Answer concisely.",
      ].filter(Boolean).join("\n");
    },
  };

  private dbPaths = new Map<string, string>();

  async initialize(_config: ProviderConfig): Promise<void> {
    // Warm up: verify tsx works
    const results = await runBatch([{ op: "recall", dbPath: join(tmpdir(), "qmd-warmup.sqlite"), query: "test", scope: "test" }]);
    if (!results[0]?.ok) logger.warn("Warmup failed: " + results[0]?.error);
    else logger.info("QMD provider ready (batch mode)");
    try { rmSync(join(tmpdir(), "qmd-warmup.sqlite"), { force: true }); } catch {}
  }

  async ingest(sessions: UnifiedSession[], options: IngestOptions): Promise<IngestResult> {
    const dbPath = this.getDbPath(options.containerTag);

    // Build batch: one extract per session
    const commands = sessions.map(session => {
      const lines = session.messages.map(msg => {
        const speaker = msg.speaker || msg.role;
        const ts = msg.timestamp ? ` [${msg.timestamp}]` : "";
        return `${speaker}${ts}: ${msg.content}`;
      });
      return { op: "extract", dbPath, text: lines.join("\n"), scope: options.containerTag };
    });

    // Run all extracts in one tsx process
    let results: any[];
    try {
      results = await runBatch(commands);
    } catch (e) {
      logger.warn(`Batch extract failed: ${e}`);
      // Fallback: store user messages directly
      const storeCmds = sessions.flatMap(s =>
        s.messages.filter(m => m.role === "user").map(m => ({
          op: "store", dbPath, text: m.content, scope: options.containerTag,
        }))
      );
      try { results = await runBatch(storeCmds); } catch { results = []; }
    }

    const documentIds: string[] = [];
    for (const r of results) {
      if (r.ok && r.extracted) {
        for (const m of r.extracted) { if (m.id) documentIds.push(m.id); }
      } else if (r.ok && r.memId) {
        documentIds.push(r.memId);
      }
    }

    // If extract yielded nothing, fallback store user messages
    if (documentIds.length === 0) {
      const storeCmds = sessions.flatMap(s =>
        s.messages.filter(m => m.role === "user").map(m => ({
          op: "store", dbPath, text: m.content, scope: options.containerTag,
        }))
      );
      try {
        const storeResults = await runBatch(storeCmds);
        for (const r of storeResults) {
          if (r.ok && r.memId) documentIds.push(r.memId);
        }
      } catch {}
    }

    return { documentIds };
  }

  async awaitIndexing(result: IngestResult, _ct: string, onProgress?: IndexingProgressCallback): Promise<void> {
    onProgress?.({ completedIds: result.documentIds, failedIds: [], total: result.documentIds.length });
  }

  async search(query: string, options: SearchOptions): Promise<unknown[]> {
    const dbPath = this.getDbPath(options.containerTag);
    const results = await runBatch([{
      op: "recall", dbPath, query, limit: options.limit || 30, scope: options.containerTag,
    }]);
    return results[0]?.results || [];
  }

  async clear(containerTag: string): Promise<void> {
    const dbPath = this.dbPaths.get(containerTag);
    if (dbPath) {
      try { rmSync(dbPath, { force: true }); } catch {}
      this.dbPaths.delete(containerTag);
    }
  }

  private getDbPath(containerTag: string): string {
    let dbPath = this.dbPaths.get(containerTag);
    if (dbPath) return dbPath;
    const dir = mkdtempSync(join(tmpdir(), "qmd-bench-"));
    dbPath = join(dir, "bench.sqlite");
    this.dbPaths.set(containerTag, dbPath);
    return dbPath;
  }
}

export default QmdProvider;
