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
const { memoryStore, memoryRecall, extractAndStore, extractReflections, consolidateEntityFacts, runDecayPass } = await import(toUrl(join(QMD_DIR, "src/memory/index.ts")));

type Database = ReturnType<typeof openDatabase>;

// ---------------------------------------------------------------------------
// LLM
// ---------------------------------------------------------------------------

type LLMProvider = "gemini" | "minimax";
// Pinned model versions for reproducibility (quality fix B)
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

  if (isAbstention) {
    return `${context}

Based on the above context, answer the following question.
If the context does NOT contain information to answer this question, respond with exactly: I don't know.

Question: ${question} Short answer:`;
  }

  return `${context}

Based on the above context, write a short, factual answer to the following question. Use exact words from the context whenever possible.

Rules:
1. Each memory has a timestamp in [brackets]. Resolve relative dates ("yesterday", "last week") to absolute dates from the timestamp.
2. For LIST questions ("what activities", "which X"), include ALL items mentioned across all memories.
3. For Yes/No questions, answer with bare "Yes" or "No".
4. For DURATION questions ("how long"), compute the time span between two dates.
5. NEVER answer with relative terms — always convert to absolute dates.
6. Output the answer ONLY — no explanation, no preamble.

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

function computeRecallAtK(memories: { text: string }[], groundTruth: string, k: number): number {
  const truthTokens = tokenize(groundTruth);
  if (truthTokens.length === 0) return 1;
  const topK = memories.slice(0, k);
  for (const m of topK) {
    const memTokens = new Set(tokenize(m.text));
    const hits = truthTokens.filter(t => memTokens.has(t)).length;
    if (hits / truthTokens.length >= 0.5) return 1;
  }
  const allTokens = new Set(topK.flatMap(m => tokenize(m.text)));
  const totalHits = truthTokens.filter(t => allTokens.has(t)).length;
  return totalHits / truthTokens.length >= 0.7 ? 1 : 0;
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
    // cat D: override LLM model for A-B testing
    if (args[i] === "--model" && args[i + 1]) {
      const m = args[i + 1]!;
      LLM_CONFIG.gemini.model = m;
      LLM_CONFIG.gemini.url = `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`;
    }
    // cat E: parallel sharding — --shard 1/4 means shard index 1 of 4 total
    if (args[i] === "--shard" && args[i + 1]) {
      const m = args[i + 1]!.match(/^(\d+)\/(\d+)$/);
      if (m) {
        shardIdx = parseInt(m[1]!, 10);
        shardTotal = parseInt(m[2]!, 10);
      }
    }
  }

  if (useLLM && !process.env[LLM_CONFIG[activeLLM].keyEnv]) {
    console.error(`Set ${LLM_CONFIG[activeLLM].keyEnv} or use --no-llm`);
    process.exit(1);
  }

  const dataPath = join(QMD_DIR, "evaluate/longmemeval", dsName === "s" ? "longmemeval_s.json" : "longmemeval_oracle.json");
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

  for (let i = 0; i < instances.length; i++) {
    const inst = instances[i]!;
    const scope = inst.question_id;

    // --- INGEST sessions for this question (skip if already ingested under this scope) ---
    const existingCount = (db.prepare(`SELECT COUNT(*) as n FROM memories WHERE scope = ?`).get(scope) as any)?.n || 0;
    if (existingCount === 0) {
      // cat B: batch extraction = one LLM call per question instead of per session.
      // Concat all session texts with date headers, run a single extractAndStore.
      // Default ON to save LLM calls. QMD_INGEST_BATCH_EXTRACT=off → per-session (legacy).
      const batchExtract = process.env.QMD_INGEST_BATCH_EXTRACT !== "off";
      const sessionTexts: string[] = [];
      for (let s = 0; s < inst.haystack_sessions.length; s++) {
        const turns = inst.haystack_sessions[s]!;
        const date = inst.haystack_dates[s] || "";
        // Store each turn as a memory
        for (const t of turns) {
          const text = date ? `[${date}] ${t.role}: ${t.content}` : `${t.role}: ${t.content}`;
          try { await memoryStore(db, { text, scope }); } catch { /* skip */ }
        }
        // Store full session as one memory (larger context)
        const sessionText = turns.map(t => `${t.role}: ${t.content}`).join("\n");
        if (date) {
          try { await memoryStore(db, { text: `[${date}]\n${sessionText}`, scope, importance: 0.7 }); } catch { /* skip */ }
        }
        sessionTexts.push(date ? `[${date}]\n${sessionText}` : sessionText);
        // Per-session extraction (legacy path)
        if (!batchExtract && process.env.QMD_INGEST_EXTRACTION !== "off") {
          try { await extractAndStore(db, sessionText, scope); } catch { /* skip */ }
        }
      }
      // Batch extraction: one LLM call per question (cat B)
      if (batchExtract && process.env.QMD_INGEST_EXTRACTION !== "off") {
        try { await extractAndStore(db, sessionTexts.join("\n\n---\n\n"), scope); } catch { /* skip */ }
      }
      // Per-question consolidation — only meaningful with ≥5 entities
      if (process.env.QMD_INGEST_SYNTHESIS !== "off") {
        try {
          const entCount = (db.prepare(`SELECT COUNT(DISTINCT subject) c FROM knowledge WHERE scope = ?`).get(scope) as any)?.c || 0;
          if (entCount >= 5) {
            await consolidateEntityFacts(db, { scope });
          }
        } catch { /* skip */ }
      }
    }

    // --- RECALL ---
    const t0 = Date.now();
    let memories: { text: string; score: number }[] = [];
    try {
      const recalled = await memoryRecall(db, { query: inst.question, limit: 10, scope });
      memories = recalled.map((m: any) => ({ text: m.text, score: m.score }));
    } catch { /* empty */ }
    const searchMs = Date.now() - t0;

    // --- ANSWER ---
    let prediction = "";
    let answerMs = 0;
    if (useLLM && memories.length > 0) {
      const t1 = Date.now();
      try {
        const prompt = buildAnswerPrompt(inst.question, memories.map(m => m.text), inst.question_type);
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
    const r5 = computeRecallAtK(memories, gt, 5);
    const r10 = computeRecallAtK(memories, gt, 10);
    runningF1 += f1;

    allResults.push({
      question_id: inst.question_id,
      question_type: inst.question_type,
      question: inst.question,
      answer: gt,
      prediction: prediction.slice(0, 300),
      memoriesFound: memories.length,
      f1, em, r5, r10,
      searchMs, answerMs,
    });

    process.stdout.write(`\r  ${progressBar(i + 1, instances.length)} F1=${(runningF1 / (i + 1) * 100).toFixed(1)}% mem=${memories.length} search=${searchMs}ms ${elapsed(globalStart)}`);
  }

  console.log("\n");

  // ---- REPORT ----
  const n = allResults.length;
  const avgF1 = allResults.reduce((s, r) => s + r.f1, 0) / n;
  const avgEM = allResults.reduce((s, r) => s + r.em, 0) / n;
  const avgR5 = allResults.reduce((s, r) => s + r.r5, 0) / n;
  const avgR10 = allResults.reduce((s, r) => s + r.r10, 0) / n;

  console.log(`${"=".repeat(64)}`);
  console.log(`  LONGMEMEVAL FINAL  (ds=${dsName}, n=${n})`);
  console.log(`${"=".repeat(64)}`);
  console.log(`  R@5:  ${(avgR5 * 100).toFixed(1)}%`);
  console.log(`  R@10: ${(avgR10 * 100).toFixed(1)}%`);
  console.log(`  F1:   ${(avgF1 * 100).toFixed(1)}%`);
  console.log(`  EM:   ${(avgEM * 100).toFixed(1)}%`);
  console.log(`  Time: ${elapsed(globalStart)}`);

  console.log(`\n  By question type:`);
  const types = [...new Set(allResults.map(r => r.question_type))].sort();
  for (const qt of types) {
    const qrs = allResults.filter(r => r.question_type === qt);
    const f1 = qrs.reduce((s, r) => s + r.f1, 0) / qrs.length;
    const em = qrs.reduce((s, r) => s + r.em, 0) / qrs.length;
    const r5 = qrs.reduce((s, r) => s + r.r5, 0) / qrs.length;
    const r10 = qrs.reduce((s, r) => s + r.r10, 0) / qrs.length;
    console.log(`    ${qt.padEnd(30)} (n=${String(qrs.length).padStart(4)}): R@5=${(r5 * 100).toFixed(0).padStart(3)}%  R@10=${(r10 * 100).toFixed(0).padStart(3)}%  F1=${(f1 * 100).toFixed(1).padStart(5)}%  EM=${(em * 100).toFixed(1).padStart(5)}%`);
  }

  // Save
  const outName = resultsTag ? `results-${resultsTag}.json` : "results.json";
  const outPath = join(QMD_DIR, "evaluate/longmemeval", outName);
  writeFileSync(outPath, JSON.stringify({
    config: { ds: dsName, useLLM, model: useLLM ? LLM_CONFIG[activeLLM].model : "none", llm: activeLLM, limit, questionTypeFilter, ablation },
    summary: { avgR5, avgR10, avgF1, avgEM, total: n },
    results: allResults,
  }, null, 2));
  console.log(`\n  Saved: ${outPath}`);

  db.close();
}

main().catch(e => { console.error(e); process.exit(1); });
