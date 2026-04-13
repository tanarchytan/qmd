/**
 * LongMemEval evaluation: QMD memory pipeline against the LongMemEval benchmark.
 *
 * Dataset: https://github.com/xiaowu0162/longmemeval (ICLR 2025)
 *   - longmemeval_oracle.json — only relevant sessions (~1.9 per question, fast)
 *   - longmemeval_s.json     — ~47 sessions per question (full retrieval)
 *
 * Usage:
 *   npx tsx evaluate/longmemeval/eval.mts --ds oracle --limit 50 --llm gemini
 *   npx tsx evaluate/longmemeval/eval.mts --ds s --limit 100 --llm gemini
 *
 * Env: same env-var toggles as locomo eval (QMD_INGEST_REFLECTIONS, QMD_RECALL_MMR, etc.)
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { pathToFileURL } from "url";
import { openCache } from "../_shared/llm-cache.js";

const LLM_CACHE_PATH = join(process.cwd(), "evaluate/longmemeval/llm-cache.json");
const llmCache = openCache(LLM_CACHE_PATH);
process.env.QMD_LLM_CACHE_PATH = LLM_CACHE_PATH;

const QMD_DIR = process.cwd();
function toUrl(p: string) { return pathToFileURL(p).href; }

const { loadQmdEnv } = await import(toUrl(join(QMD_DIR, "src/env.ts")));
loadQmdEnv();

const { openDatabase } = await import(toUrl(join(QMD_DIR, "src/db.ts")));
const { initializeDatabase } = await import(toUrl(join(QMD_DIR, "src/store/db-init.ts")));
const { memoryStore, memoryStoreBatch, memoryRecall, extractAndStore, extractReflections, consolidateEntityFacts, runDecayPass, memoryReflect } = await import(toUrl(join(QMD_DIR, "src/memory/index.ts")));

type Database = ReturnType<typeof openDatabase>;

// ---------------------------------------------------------------------------
// LLM
// ---------------------------------------------------------------------------

type LLMProvider = "gemini" | "minimax";
const LLM_CONFIG: Record<LLMProvider, { url: string; model: string; keyEnv: string }> = {
  gemini: {
    url: "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
    model: "gemini-2.5-flash",
    keyEnv: "GOOGLE_API_KEY",
  },
  minimax: {
    url: "https://api.minimax.io/v1/chat/completions",
    model: "MiniMax-M2.7",
    keyEnv: "MINIMAX_API_KEY",
  },
};
const LLM_SEED = 42;
let activeLLM: LLMProvider = "gemini";

// Build a Gemini URL for arbitrary model name (used by --extract-model split)
function geminiUrl(model: string): string {
  return `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
}

async function askGemini(prompt: string, apiKey: string): Promise<string> {
  const cacheKey = { model: LLM_CONFIG.gemini.model, temperature: 0, seed: LLM_SEED, prompt };
  const cached = llmCache.get(cacheKey);
  if (cached != null) return cached;

  const url = `${LLM_CONFIG.gemini.url}?key=${apiKey}`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0, seed: LLM_SEED, maxOutputTokens: 256 },
    }),
  });
  if (!resp.ok) throw new Error(`Gemini ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  const data = await resp.json() as any;
  let text = data.candidates?.[0]?.content?.parts
    ?.filter((p: any) => p.text && !p.thought)
    ?.map((p: any) => p.text).join("") || "";
  text = text.replace(/^["']|["']$/g, "").trim();
  llmCache.set(cacheKey, text);
  return text;
}

async function askLLM(prompt: string): Promise<string> {
  const cfg = LLM_CONFIG[activeLLM];
  const apiKey = process.env[cfg.keyEnv];
  if (!apiKey) throw new Error(`${cfg.keyEnv} not set`);
  if (activeLLM !== "gemini") throw new Error("Only gemini supported in this script");
  return askGemini(prompt, apiKey);
}

function buildAnswerPrompt(question: string, memories: string[], questionType: string): string {
  const context = memories.map((m, i) => `[${i + 1}] ${m}`).join("\n");
  const isAbstention = questionType.endsWith("_abs");
  const useV111 = (process.env.QMD_PROMPT_RULES || "v11") === "v11.1";

  if (isAbstention) {
    return `${context}

Based on the above context, answer the following question.
If the context does NOT contain information to answer this question, respond with exactly: I don't know.

Question: ${question} Short answer:`;
  }

  const extraRules = useV111 ? `
7. For ORDERING questions ("which came first", "which did I X first/earlier"), compare the dates/timestamps in the context and pick the item with the earlier date. If both dates are present, NEVER refuse.
8. For DURATION questions ("how long", "how many days/weeks/months between X and Y"), if both anchor dates are present in context, compute the difference and answer with number + unit (e.g. "7 days", "two months"). NEVER respond with "context does not provide" when both dates are visible.
9. For COUNTING questions ("how many X"), enumerate every matching item from the context first, then count them. Do not estimate.` : "";

  return `${context}

Based on the above context, write a short, factual answer to the following question. Use exact words from the context whenever possible.

Rules:
1. Each memory has a timestamp in [brackets]. Resolve relative dates ("yesterday", "last week") to absolute dates from the timestamp.
2. For LIST questions ("what activities", "which X"), include ALL items mentioned across all memories.
3. For Yes/No questions, answer with bare "Yes" or "No".
4. For DURATION questions ("how long"), compute the time span between two dates.
5. NEVER answer with relative terms — always convert to absolute dates.
6. Output the answer ONLY — no explanation, no preamble.${extraRules}

Question: ${question} Short answer:`;
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

function tokenize(text: string): string[] {
  return String(text || "").toLowerCase().replace(/[^\w\s]/g, " ").split(/\s+/).filter(t => t.length > 0);
}

function computeF1(prediction: string, groundTruth: string): number {
  const p = tokenize(prediction);
  const t = tokenize(groundTruth);
  if (p.length === 0 && t.length === 0) return 1;
  if (p.length === 0 || t.length === 0) return 0;
  const ts = new Set(t);
  const overlap = p.filter(x => ts.has(x)).length;
  if (overlap === 0) return 0;
  const prec = overlap / p.length;
  const rec = overlap / t.length;
  return (2 * prec * rec) / (prec + rec);
}

function computeEM(prediction: string, groundTruth: string): number {
  return tokenize(prediction).join(" ") === tokenize(groundTruth).join(" ") ? 1 : 0;
}

/**
 * Substring-Hit — lenient answer-quality check that catches F1's blind
 * spot on short numeric / name answers. "27" ⊂ "27 years old" → 1.
 * Uses the same tokenization as F1/EM so "30 days" matches "30 days."
 * and "Tom" matches "Tom, I met him first".
 */
function computeSubstringHit(prediction: string, groundTruth: string): number {
  const p = tokenize(prediction).join(" ");
  const t = tokenize(groundTruth).join(" ");
  if (t.length === 0) return 1;
  if (p.length === 0) return 0;
  return p.includes(t) ? 1 : 0;
}

/** Returns true iff the memory text covers ≥50% of the ground-truth tokens. */
function memoryHitsTruth(text: string, truthTokens: string[]): boolean {
  if (truthTokens.length === 0) return true;
  const memTokens = new Set(tokenize(text));
  const hits = truthTokens.filter(t => memTokens.has(t)).length;
  return hits / truthTokens.length >= 0.5;
}

function computeRecallAtK(memories: { text: string }[], groundTruth: string, k: number): number {
  const truthTokens = tokenize(groundTruth);
  if (truthTokens.length === 0) return 1;
  const topK = memories.slice(0, k);
  for (const m of topK) {
    if (memoryHitsTruth(m.text, truthTokens)) return 1;
  }
  const allTokens = new Set(topK.flatMap(m => tokenize(m.text)));
  const totalHits = truthTokens.filter(t => allTokens.has(t)).length;
  return totalHits / truthTokens.length >= 0.7 ? 1 : 0;
}

/**
 * MRR — Mean Reciprocal Rank over the first top-K memories, using the
 * same token-overlap relevance definition as R@K. Rewards rank quality:
 * finding the answer at rank 1 scores 1.0, rank 3 scores 0.33, not in
 * top-K scores 0.
 */
function computeMRR(memories: { text: string }[], groundTruth: string, k: number): number {
  const truthTokens = tokenize(groundTruth);
  if (truthTokens.length === 0) return 1;
  const topK = memories.slice(0, k);
  for (let i = 0; i < topK.length; i++) {
    if (memoryHitsTruth(topK[i]!.text, truthTokens)) {
      return 1 / (i + 1);
    }
  }
  return 0;
}

/**
 * Session-id-based recall — apples-to-apples with MemPalace's `recall_any`.
 * Returns 1 if any retrieved memory came from a session in answer_session_ids.
 *
 * Each memory carries a JSON metadata blob with source_session_id (set at
 * ingest time). We extract it, check intersection with the question's
 * answer_session_ids, and report binary hit/miss.
 *
 * MemPalace's longmemeval_bench.py uses this exact metric. Comparing this
 * number to their 96.6% R@5 gives a fair side-by-side.
 */
function computeSessionRecallAtK(
  memories: Array<{ metadata?: string | null }>,
  answerSessionIds: string[],
  k: number,
): number {
  if (answerSessionIds.length === 0) return 1;
  const correct = new Set(answerSessionIds);
  const topK = memories.slice(0, k);
  for (const m of topK) {
    if (!m.metadata) continue;
    try {
      const meta = JSON.parse(m.metadata) as { source_session_id?: string };
      if (meta.source_session_id && correct.has(meta.source_session_id)) return 1;
    } catch { /* skip malformed metadata */ }
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface LMETurn { role: string; content: string; has_answer?: boolean; }
interface LMEInstance {
  question_id: string;
  question_type: string;
  question: string;
  answer: string;
  question_date: string;
  haystack_dates: string[];
  haystack_session_ids: string[];
  haystack_sessions: LMETurn[][];
  answer_session_ids: string[];
}

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------

function progressBar(current: number, total: number, width = 30): string {
  const pct = total > 0 ? current / total : 0;
  const filled = Math.round(pct * width);
  return `[${"\u2588".repeat(filled)}${"\u2591".repeat(width - filled)}] ${(pct * 100).toFixed(0).padStart(3)}% (${current}/${total})`;
}
function elapsed(startMs: number): string {
  const s = Math.floor((Date.now() - startMs) / 1000);
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}m${s % 60}s` : `${s}s`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  let limit = 0;
  let dsName = "oracle";       // oracle | s
  let questionTypeFilter: string | null = null;
  let resultsTag = "";
  let dbSuffix = "";
  let useLLM = true;
  let shardIdx = 0;            // cat E: 0-indexed shard
  let shardTotal = 1;          // cat E: total shards

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--ds" && args[i + 1]) dsName = args[i + 1]!;
    if (args[i] === "--limit" && args[i + 1]) limit = parseInt(args[i + 1]!, 10);
    if (args[i] === "--type" && args[i + 1]) questionTypeFilter = args[i + 1]!;
    if (args[i] === "--llm" && args[i + 1]) activeLLM = args[i + 1] as LLMProvider;
    if (args[i] === "--tag" && args[i + 1]) resultsTag = args[i + 1]!;
    if (args[i] === "--db-suffix" && args[i + 1]) dbSuffix = "-" + args[i + 1];
    if (args[i] === "--no-llm") useLLM = false;
    // cat D: override LLM model for A-B testing — sets BOTH extract and answer model
    if (args[i] === "--model" && args[i + 1]) {
      const m = args[i + 1]!;
      LLM_CONFIG.gemini.model = m;
      LLM_CONFIG.gemini.url = geminiUrl(m);
      // Also override the extraction model used by chatComplete in src/llm.ts
      process.env.QMD_QUERY_EXPANSION_MODEL = m;
    }
    // --answer-model: override only the answer-generation model (cat D split)
    if (args[i] === "--answer-model" && args[i + 1]) {
      const m = args[i + 1]!;
      LLM_CONFIG.gemini.model = m;
      LLM_CONFIG.gemini.url = geminiUrl(m);
    }
    // --extract-model was here historically but it pointed at QMD_QUERY_EXPANSION_MODEL
    // which is read by the query-expansion path, not the memory extractor. That caused
    // queryExpansion to 404 when passed a Gemini model name. Removed until a proper
    // per-call extractor model override is implemented in src/memory/extractor.ts.
    // cat E: parallel sharding — --shard 1/4 means shard index 1 of 4 total
    if (args[i] === "--shard" && args[i + 1]) {
      const m = args[i + 1]!.match(/^(\d+)\/(\d+)$/);
      if (m) {
        shardIdx = parseInt(m[1]!, 10);
        shardTotal = parseInt(m[2]!, 10);
      }
    }
    // --workers N: in-process worker pool (concurrent question processing).
    // Each worker pulls questions from a shared index queue. SQLite blocks
    // briefly on writes, but await calls (LLM/embed) suspend the worker so
    // others can run. Net 4-8x speedup for IO-heavy workloads.
    if (args[i] === "--workers" && args[i + 1]) {
      process.env.QMD_LME_WORKERS = args[i + 1]!;
    }
  }

  if (useLLM && !process.env[LLM_CONFIG[activeLLM].keyEnv]) {
    console.error(`Set ${LLM_CONFIG[activeLLM].keyEnv} or use --no-llm`);
    process.exit(1);
  }

  // --ds s now prefers the huggingface-released longmemeval_s_cleaned.json
  // (277 MB, 500 questions with full distractor haystack). Falls back to the
  // original longmemeval_s.json if cleaned isn't present.
  const sPreferred = join(QMD_DIR, "evaluate/longmemeval", "longmemeval_s_cleaned.json");
  const sFallback = join(QMD_DIR, "evaluate/longmemeval", "longmemeval_s.json");
  const sPath = existsSync(sPreferred) ? sPreferred : sFallback;
  const dataPath = dsName === "s"
    ? sPath
    : join(QMD_DIR, "evaluate/longmemeval", "longmemeval_oracle.json");
  console.log(`\n  Loading ${dataPath}...`);
  const data: LMEInstance[] = JSON.parse(readFileSync(dataPath, "utf-8"));
  console.log(`  Loaded ${data.length} instances`);

  let instances = data;
  if (questionTypeFilter) instances = instances.filter(q => q.question_type === questionTypeFilter);
  if (limit > 0) instances = instances.slice(0, limit);
  // cat E: shard the question list — each shard processes every Nth question starting at shardIdx
  if (shardTotal > 1) {
    instances = instances.filter((_, idx) => idx % shardTotal === shardIdx);
    console.log(`  Sharding: this is shard ${shardIdx}/${shardTotal} → ${instances.length} questions`);
  }
  console.log(`  Running: ${instances.length} questions${questionTypeFilter ? ` (type=${questionTypeFilter})` : ""}`);

  const ablation = {
    INGEST_SYNTHESIS: process.env.QMD_INGEST_SYNTHESIS !== "off",
    INGEST_REFLECTIONS: process.env.QMD_INGEST_REFLECTIONS !== "off",
    PROMPT_RULES: process.env.QMD_PROMPT_RULES || "v11",
    RECALL_DUAL_PASS: process.env.QMD_RECALL_DUAL_PASS === "on",
    RECALL_LOG_MOD: process.env.QMD_RECALL_LOG_MOD === "on",
    RECALL_MMR: process.env.QMD_RECALL_MMR === "on",
  };
  console.log(`  Ablation: ${JSON.stringify(ablation)}\n`);

  // One DB per shard so SQLite WAL doesn't contend across workers
  const dbDir = join(QMD_DIR, "evaluate/longmemeval/dbs");
  if (!existsSync(dbDir)) mkdirSync(dbDir, { recursive: true });
  const shardLabel = shardTotal > 1 ? `-shard${shardIdx}of${shardTotal}` : "";
  const dbPath = join(dbDir, `lme-${dsName}${dbSuffix}${shardLabel}.sqlite`);
  const dbExists = existsSync(dbPath);
  const db: Database = openDatabase(dbPath);
  initializeDatabase(db);

  const allResults: any[] = [];
  const globalStart = Date.now();
  let runningF1 = 0;
  let completed = 0;

  // Per-question handler — pure function, safe to run concurrently.
  // Workers share the SQLite db; better-sqlite3 calls block the JS thread
  // briefly but await calls (LLM, embed) suspend so other workers run.
  async function processQuestion(inst: LMEInstance): Promise<void> {
    const scope = inst.question_id;

    // --- INGEST sessions for this question (skip if already ingested under this scope) ---
    const existingCount = (db.prepare(`SELECT COUNT(*) as n FROM memories WHERE scope = ?`).get(scope) as any)?.n || 0;
    if (existingCount === 0) {
      const storeTurns = process.env.QMD_INGEST_PER_TURN !== "off";
      const storeSessions = process.env.QMD_INGEST_SESSION_AS_MEMORY !== "off";
      const batchExtract = process.env.QMD_INGEST_BATCH_EXTRACT !== "off";

      const sessionTexts: string[] = [];
      const turnBatch: Array<{ text: string; scope: string; importance?: number; metadata?: Record<string, unknown> }> = [];

      for (let s = 0; s < inst.haystack_sessions.length; s++) {
        const turns = inst.haystack_sessions[s]!;
        const date = inst.haystack_dates[s] || "";
        const sessionId = inst.haystack_session_ids[s] || `session_${s}`;
        if (storeTurns) {
          for (let t = 0; t < turns.length; t++) {
            const turn = turns[t]!;
            const text = date ? `[${date}] ${turn.role}: ${turn.content}` : `${turn.role}: ${turn.content}`;
            turnBatch.push({ text, scope, metadata: { source_session_id: sessionId, turn_index: t } });
          }
        }
        const sessionText = turns.map(t => `${t.role}: ${t.content}`).join("\n");
        if (storeSessions && date) {
          turnBatch.push({ text: `[${date}]\n${sessionText}`, scope, importance: 0.7, metadata: { source_session_id: sessionId } });
        }
        sessionTexts.push(date ? `[${date}]\n${sessionText}` : sessionText);
        if (!batchExtract && process.env.QMD_INGEST_EXTRACTION !== "off") {
          try { await extractAndStore(db, sessionText, scope); } catch { /* skip */ }
        }
      }

      if (turnBatch.length > 0) {
        try { await memoryStoreBatch(db, turnBatch); } catch (e) {
          for (const item of turnBatch) { try { await memoryStore(db, item); } catch {} }
        }
      }

      if (batchExtract && process.env.QMD_INGEST_EXTRACTION !== "off") {
        try { await extractAndStore(db, sessionTexts.join("\n\n---\n\n"), scope); } catch { /* skip */ }
      }
      if (process.env.QMD_INGEST_SYNTHESIS !== "off") {
        try {
          const entCount = (db.prepare(`SELECT COUNT(DISTINCT subject) c FROM knowledge WHERE scope = ?`).get(scope) as any)?.c || 0;
          if (entCount >= 5) await consolidateEntityFacts(db, { scope });
        } catch { /* skip */ }
      }
    }

    // --- RECALL ---
    const t0 = Date.now();
    let memories: { text: string; score: number; metadata?: string | null }[] = [];
    try {
      // Pull top-50 to match MemPalace default top_k; slice locally for SR@5/@10/@15/@50.
      const recalled = await memoryRecall(db, { query: inst.question, limit: 50, scope });
      memories = recalled.map((m: any) => ({ text: m.text, score: m.score, metadata: m.metadata }));
    } catch { /* empty */ }
    const searchMs = Date.now() - t0;

    // --- OPTIONAL REFLECT (roadmap cat 11): pre-filter memories into a
    // compressed fact list before the answer call. Opt-in via
    // QMD_RECALL_REFLECT=on. Adds one extra LLM call per question.
    //
    // v16.1 fix: AUGMENT the memory list with the reflection block at
    // the top — don't REPLACE it. v16-full shipped replacement and lost
    // ~20pp F1 on LME because the compressed bullets dropped exact
    // wording the answer model needed for date arithmetic and ordering.
    let answerMemories = memories.map(m => m.text);
    if (process.env.QMD_RECALL_REFLECT === "on" && memories.length > 0 && useLLM) {
      try {
        const reflected = await memoryReflect(inst.question, memories, { maxFacts: 8 });
        if (reflected) {
          answerMemories = [`[reflected facts]\n${reflected}`, ...answerMemories];
        }
      } catch { /* fall back to raw memories */ }
    }

    // --- ANSWER ---
    let prediction = "";
    let answerMs = 0;
    if (useLLM && memories.length > 0) {
      const t1 = Date.now();
      try {
        const prompt = buildAnswerPrompt(inst.question, answerMemories, inst.question_type);
        prediction = await askLLM(prompt);
      } catch (e) {
        prediction = memories.map(m => m.text).join(" ").slice(0, 300);
        process.stderr.write(`\n[warn] LLM failed: ${e}\n`);
      }
      answerMs = Date.now() - t1;
    } else {
      prediction = memories.map(m => m.text).join(" ").slice(0, 300);
    }

    const gt = String(inst.answer || "");
    const f1 = computeF1(prediction, gt);
    const em = computeEM(prediction, gt);
    const sh = computeSubstringHit(prediction, gt);
    const r5 = computeRecallAtK(memories, gt, 5);
    const r10 = computeRecallAtK(memories, gt, 10);
    const mrr = computeMRR(memories, gt, 10);
    const sr5 = computeSessionRecallAtK(memories, inst.answer_session_ids || [], 5);
    const sr10 = computeSessionRecallAtK(memories, inst.answer_session_ids || [], 10);
    const sr15 = computeSessionRecallAtK(memories, inst.answer_session_ids || [], 15);
    const sr50 = computeSessionRecallAtK(memories, inst.answer_session_ids || [], 50);
    runningF1 += f1;
    completed++;

    allResults.push({
      question_id: inst.question_id,
      question_type: inst.question_type,
      question: inst.question,
      answer: gt,
      prediction: prediction.slice(0, 300),
      memoriesFound: memories.length,
      f1, em, sh, r5, r10, mrr, sr5, sr10, sr15, sr50,
      searchMs, answerMs,
    });

    process.stdout.write(`\r  ${progressBar(completed, instances.length)} F1=${(runningF1 / completed * 100).toFixed(1)}% mem=${memories.length} search=${searchMs}ms ${elapsed(globalStart)}`);
  }

  // Worker pool: N concurrent workers pulling from a shared index queue.
  // QMD_LME_WORKERS=1 (default) preserves the original sequential behavior.
  const concurrency = Math.max(1, parseInt(process.env.QMD_LME_WORKERS || "1", 10));
  const queue = [...instances];
  if (concurrency > 1) {
    console.log(`  Workers: ${concurrency} concurrent (--workers ${concurrency})`);
  }
  const worker = async () => {
    while (queue.length > 0) {
      const inst = queue.shift();
      if (!inst) break;
      try { await processQuestion(inst); }
      catch (e) { process.stderr.write(`\n[error] question ${inst.question_id}: ${e}\n`); }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  console.log("\n");

  // ---- REPORT ----
  const n = allResults.length;
  const avgF1 = allResults.reduce((s, r) => s + r.f1, 0) / n;
  const avgEM = allResults.reduce((s, r) => s + r.em, 0) / n;
  const avgSH = allResults.reduce((s, r) => s + r.sh, 0) / n;
  const avgR5 = allResults.reduce((s, r) => s + r.r5, 0) / n;
  const avgR10 = allResults.reduce((s, r) => s + r.r10, 0) / n;
  const avgMRR = allResults.reduce((s, r) => s + r.mrr, 0) / n;
  const avgSR5 = allResults.reduce((s, r) => s + r.sr5, 0) / n;
  const avgSR10 = allResults.reduce((s, r) => s + r.sr10, 0) / n;
  const avgSR15 = allResults.reduce((s, r) => s + r.sr15, 0) / n;
  const avgSR50 = allResults.reduce((s, r) => s + r.sr50, 0) / n;

  console.log(`${"=".repeat(64)}`);
  console.log(`  LONGMEMEVAL FINAL  (ds=${dsName}, n=${n})`);
  console.log(`${"=".repeat(64)}`);
  console.log(`  Retrieval (primary — what actually matters):`);
  console.log(`    R@5:    ${(avgR5 * 100).toFixed(1)}%   (single-pass)`);
  console.log(`    R@10:   ${(avgR10 * 100).toFixed(1)}%   (multi-pass)`);
  console.log(`    MRR:    ${avgMRR.toFixed(3)}    (rank quality, 1/rank of first hit)`);
  console.log(`  Answer quality (primary):`);
  console.log(`    F1:     ${(avgF1 * 100).toFixed(1)}%   (token overlap, fuzzy)`);
  console.log(`    EM:     ${(avgEM * 100).toFixed(1)}%   (exact match, strict)`);
  console.log(`    SH:     ${(avgSH * 100).toFixed(1)}%   (substring hit — catches short-answer EM false negatives)`);
  console.log(`  MemPalace-compat (reference only, session-id recall — hits ceiling easily on oracle):`);
  console.log(`    SR@5 / SR@10 / SR@15 / SR@50 = ${(avgSR5 * 100).toFixed(1)}% / ${(avgSR10 * 100).toFixed(1)}% / ${(avgSR15 * 100).toFixed(1)}% / ${(avgSR50 * 100).toFixed(1)}%`);
  console.log(`  Time: ${elapsed(globalStart)}`);

  console.log(`\n  By question type (R@5 / R@10 / F1 / EM / SH):`);
  const types = [...new Set(allResults.map(r => r.question_type))].sort();
  for (const qt of types) {
    const qrs = allResults.filter(r => r.question_type === qt);
    const f1 = qrs.reduce((s, r) => s + r.f1, 0) / qrs.length;
    const em = qrs.reduce((s, r) => s + r.em, 0) / qrs.length;
    const sh = qrs.reduce((s, r) => s + r.sh, 0) / qrs.length;
    const r5 = qrs.reduce((s, r) => s + r.r5, 0) / qrs.length;
    const r10 = qrs.reduce((s, r) => s + r.r10, 0) / qrs.length;
    console.log(`    ${qt.padEnd(24)} (n=${String(qrs.length).padStart(4)}): R@5=${(r5 * 100).toFixed(0).padStart(3)}%  R@10=${(r10 * 100).toFixed(0).padStart(3)}%  F1=${(f1 * 100).toFixed(1).padStart(5)}%  EM=${(em * 100).toFixed(1).padStart(5)}%  SH=${(sh * 100).toFixed(1).padStart(5)}%`);
  }

  // Save
  const outName = resultsTag ? `results-${resultsTag}.json` : "results.json";
  const outPath = join(QMD_DIR, "evaluate/longmemeval", outName);
  writeFileSync(outPath, JSON.stringify({
    config: { ds: dsName, useLLM, model: useLLM ? LLM_CONFIG[activeLLM].model : "none", llm: activeLLM, limit, questionTypeFilter, ablation },
    summary: {
      // Primary metrics
      avgR5, avgR10, avgMRR, avgF1, avgEM, avgSH,
      // MemPalace-compat reference (demoted)
      avgSR5, avgSR10, avgSR15, avgSR50,
      total: n,
    },
    results: allResults,
  }, null, 2));
  console.log(`\n  Saved: ${outPath}`);

  db.close();
}

main().catch(e => { console.error(e); process.exit(1); });
