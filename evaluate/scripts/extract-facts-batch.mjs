#!/usr/bin/env node
/**
 * Phase 5 batch fact/triple extraction runner.
 *
 * Iterates every row in the `memories` table, calls an LLM to extract
 * {facts, triples} per the Phase 5 design prompt, and:
 *   - stores facts joined with newlines → memories.fact_text
 *   - calls the local embedder (mxbai-xs) → stores BLOB in memories.fact_embedding
 *   - inserts triples via memory/knowledge.ts's knowledge_add
 *
 * Design: devnotes/architecture/phase5-kg-and-fact-aug-design.md
 * Default model: google/gemma-4-e4b via LM Studio (fast, free). Override
 * with LOTL_LMSTUDIO_GEN_MODEL. Gemini / Poe also work via LOTL_EXTRACT_PROVIDER.
 *
 * Cache: responses keyed by sha256(prompt_version + turn_text). Re-runs are
 * free — delete evaluate/<bench>/llm-cache-facts.json to force regen.
 *
 * Usage:
 *   node evaluate/scripts/extract-facts-batch.mjs <sqlite-db> [--provider lmstudio|gemini|poe] [--limit N]
 *
 * Example (LME canonical DB, via LM Studio gemma):
 *   node evaluate/scripts/extract-facts-batch.mjs \
 *     evaluate/longmemeval/dbs/lme-s-mxbai-n500-v17.sqlite \
 *     --provider lmstudio --limit 100
 *
 * Expected wall on n=500 with gemma-4-e4b at parallel=8:
 *   ~500 × ~3s / 8 = ~3 min (facts are short, < 200 output tokens each).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";

// --- CLI ---
const args = process.argv.slice(2);
const dbPath = args[0];
let provider = "lmstudio";
let limit = 0;
for (let i = 1; i < args.length; i++) {
  if (args[i] === "--provider" && args[i + 1]) { provider = args[i + 1]; i++; }
  else if (args[i] === "--limit" && args[i + 1]) { limit = parseInt(args[i + 1], 10); i++; }
}
if (!dbPath || !existsSync(dbPath)) {
  console.error("usage: extract-facts-batch.mjs <sqlite-db> [--provider lmstudio|gemini|poe] [--limit N]");
  process.exit(2);
}

const LOTL_DIR = process.cwd();
const toUrl = (p) => pathToFileURL(p).href;

// Lazy-load Lotl internals so this script only pulls them once CLI args are valid.
const { loadQmdEnv } = await import(toUrl(join(LOTL_DIR, "src/env.ts")));
loadQmdEnv();
const { openDatabase } = await import(toUrl(join(LOTL_DIR, "src/db.ts")));
const { initializeDatabase } = await import(toUrl(join(LOTL_DIR, "src/store/db-init.ts")));
const { ensureMemoriesVecFactTable } = await import(toUrl(join(LOTL_DIR, "src/memory/index.ts")));
const { knowledgeStore } = await import(toUrl(join(LOTL_DIR, "src/memory/knowledge.ts")));
const { buildFactExtractionPrompt, parseFactExtraction, factExtractionCacheKey, factsToEmbeddableText, FACT_EXTRACTION_PROMPT_VERSION } = await import(toUrl(join(LOTL_DIR, "src/memory/fact-extractor.ts")));

// --- Simple per-run cache (disk-backed) ---
const CACHE_PATH = join(dirname(dbPath), `llm-cache-facts.json`);
let cache = {};
if (existsSync(CACHE_PATH)) {
  try { cache = JSON.parse(readFileSync(CACHE_PATH, "utf8")); } catch { cache = {}; }
}
let cachePending = 0;
const flushCache = () => {
  if (cachePending === 0) return;
  mkdirSync(dirname(CACHE_PATH), { recursive: true });
  writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
  cachePending = 0;
};
process.on("exit", flushCache);

// --- Provider ---
const LMSTUDIO_HOST = process.env.LOTL_LMSTUDIO_HOST || "localhost:1234";
const LMSTUDIO_MODEL = process.env.LOTL_LMSTUDIO_GEN_MODEL || "google/gemma-4-e4b";
const LMSTUDIO_KEY = process.env.LOTL_LMSTUDIO_KEY || "lm-studio";

async function callLLM(prompt) {
  const key = factExtractionCacheKey(prompt);
  if (cache[key] != null) return cache[key];

  let raw;
  if (provider === "lmstudio") {
    const resp = await fetch(`http://${LMSTUDIO_HOST}/v1/chat/completions`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${LMSTUDIO_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: LMSTUDIO_MODEL,
        messages: [{ role: "user", content: prompt }],
        temperature: 0,
        seed: 42,
        max_tokens: Number(process.env.LOTL_EXTRACT_MAX_TOKENS ?? 512),
      }),
    });
    if (!resp.ok) throw new Error(`lmstudio ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
    const data = await resp.json();
    // Thinking-model fallback: qwen3.6 routes structured output into reasoning_content.
    const msg = data.choices?.[0]?.message;
    raw = (msg?.content && msg.content.length > 0) ? msg.content : (msg?.reasoning_content || "");
  } else if (provider === "gemini") {
    const apiKey = process.env.GOOGLE_API_KEY;
    if (!apiKey) throw new Error("GOOGLE_API_KEY not set");
    const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0, seed: 42, maxOutputTokens: 512 },
      }),
    });
    if (!resp.ok) throw new Error(`gemini ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
    const data = await resp.json();
    raw = data.candidates?.[0]?.content?.parts?.filter((p) => p.text)?.map((p) => p.text).join("") || "";
  } else {
    throw new Error(`unsupported provider: ${provider}`);
  }

  cache[key] = raw;
  cachePending++;
  if (cachePending >= 10) flushCache();
  return raw;
}

// --- Embedder ---
// Lazy-load to avoid pulling onnxruntime when --provider=gemini and an external
// embedder is available. For local runs, use whatever the DB was embedded with.
let embedBatch;
async function ensureEmbedder() {
  if (embedBatch) return embedBatch;
  const mod = await import(toUrl(join(LOTL_DIR, "src/llm/transformers-embed.ts")));
  // Match the DB's embedder. mxbai-xs is the shipped default.
  const model = process.env.LOTL_EMBED_MODEL || "mixedbread-ai/mxbai-embed-xsmall-v1";
  const backend = await mod.createTransformersEmbedBackend({ model, dtype: "q8" });
  embedBatch = async (texts) => {
    const results = await backend.embedBatch(texts);
    return results.map((r) => r?.embedding ?? null);
  };
  return embedBatch;
}

// --- Main ---
const db = openDatabase(dbPath);
initializeDatabase(db);

const rows = db.prepare(`SELECT id, text, scope FROM memories WHERE fact_text IS NULL ${limit > 0 ? `LIMIT ${limit}` : ""}`).all();
console.log(`Found ${rows.length} memories without fact_text. Extracting...`);

const updateStmt = db.prepare(`UPDATE memories SET fact_text = ?, fact_embedding = ? WHERE id = ?`);
let done = 0, skipped = 0, failed = 0;
let vecFactStmt = null; // lazy — only prepare after we know embed dim

// Truncate input to keep total prompt under typical LM Studio per-slot ctx
// (default 4096 tokens ≈ ~12000 chars after prompt template overhead).
// Fact extraction loses little from truncation — facts cluster in the
// first few turns of each session-level memory.
const MAX_INPUT_CHARS = Number(process.env.LOTL_EXTRACT_MAX_INPUT_CHARS ?? 10000);

for (const row of rows) {
  try {
    const input = row.text.length > MAX_INPUT_CHARS
      ? row.text.slice(0, MAX_INPUT_CHARS) + "\n[…truncated]"
      : row.text;
    const prompt = buildFactExtractionPrompt(input);
    const raw = await callLLM(prompt);
    const parsed = parseFactExtraction(raw);
    if (!parsed) { failed++; continue; }
    const factText = factsToEmbeddableText(parsed.facts);
    let factEmb = null;
    if (factText.length > 0) {
      const embed = await ensureEmbedder();
      const [emb] = await embed([factText]);
      factEmb = Buffer.from(new Float32Array(emb).buffer);
      // Phase 5b — mirror into memories_vec_fact so LOTL_MEMORY_EMBED_SOURCE=fact
      // recall queries can hit fact embeddings via vec0 KNN.
      if (!vecFactStmt) {
        ensureMemoriesVecFactTable(db, emb.length);
        vecFactStmt = db.prepare(`INSERT INTO memories_vec_fact (scope, id, embedding) VALUES (?, ?, ?)`);
      }
      try { vecFactStmt.run(row.scope || "global", row.id, new Float32Array(emb)); } catch {}
    }
    updateStmt.run(factText || null, factEmb, row.id);

    // Phase 5a — push extracted SPO triples into the knowledge graph. Scope
    // copied from source memory. Confidence held at 1.0 (LLM extraction is
    // the trust floor; future work can score per-triple).
    for (const t of parsed.triples || []) {
      try {
        knowledgeStore(db, {
          subject: t.subject,
          predicate: t.predicate,
          object: t.object,
          scope: row.scope || "global",
          confidence: 1.0,
        });
      } catch (e) {
        process.stderr.write(`[kg] triple failed id=${row.id} ${t.subject}/${t.predicate}/${t.object}: ${e.message}\n`);
      }
    }

    done++;
  } catch (e) {
    process.stderr.write(`[extract] failed id=${row.id}: ${e.message}\n`);
    failed++;
  }
  if ((done + skipped + failed) % 25 === 0) {
    process.stdout.write(`\r  ${done + skipped + failed}/${rows.length} processed`);
  }
}

flushCache();
db.close();
console.log(`\nDone. ${done} extracted, ${skipped} skipped, ${failed} failed. cache=${CACHE_PATH} (${Object.keys(cache).length} entries, v${FACT_EXTRACTION_PROMPT_VERSION})`);
