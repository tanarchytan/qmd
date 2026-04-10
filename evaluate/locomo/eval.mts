/**
 * LoCoMo evaluation: QMD memory retrieval + MiniMax answering.
 *
 * Usage:
 *   npx tsx evaluate/locomo/eval.mts [--limit N] [--conv SAMPLE_ID] [--no-llm]
 *
 * Env:
 *   MINIMAX_API_KEY  — MiniMax API key (required unless --no-llm)
 *
 * Flow per question:
 *   1. QMD memoryRecall → top 10 memories
 *   2. MiniMax reads memories → generates answer
 *   3. Score answer vs ground truth (F1 + exact match)
 */

import { readFileSync, writeFileSync, rmSync, mkdtempSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { pathToFileURL } from "url";

// ---------------------------------------------------------------------------
// QMD imports
// ---------------------------------------------------------------------------

const QMD_DIR = process.cwd();
function toUrl(p: string) { return pathToFileURL(p).href; }

const { loadQmdEnv } = await import(toUrl(join(QMD_DIR, "src/env.ts")));
loadQmdEnv();

const { openDatabase } = await import(toUrl(join(QMD_DIR, "src/db.ts")));
const { initializeDatabase } = await import(toUrl(join(QMD_DIR, "src/store/db-init.ts")));
const { memoryStore, memoryRecall } = await import(toUrl(join(QMD_DIR, "src/memory/index.ts")));

type Database = ReturnType<typeof openDatabase>;

// ---------------------------------------------------------------------------
// MiniMax LLM
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// LLM providers
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

let activeLLM: LLMProvider = "gemini"; // default

async function askLLM(prompt: string): Promise<string> {
  const cfg = LLM_CONFIG[activeLLM];
  const apiKey = process.env[cfg.keyEnv];
  if (!apiKey) throw new Error(`${cfg.keyEnv} not set`);

  if (activeLLM === "gemini") {
    return askGemini(prompt, apiKey);
  }
  return askMiniMax(prompt, apiKey);
}

async function askGemini(prompt: string, apiKey: string): Promise<string> {
  const url = `${LLM_CONFIG.gemini.url}?key=${apiKey}`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0,
        maxOutputTokens: 256,
      },
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Gemini ${resp.status}: ${body.slice(0, 200)}`);
  }

  const data = await resp.json() as any;
  let text = data.candidates?.[0]?.content?.parts
    ?.filter((p: any) => p.text && !p.thought)
    ?.map((p: any) => p.text)
    ?.join("") || "";
  text = text.replace(/^["']|["']$/g, "").trim();
  return text;
}

async function askMiniMax(prompt: string, apiKey: string): Promise<string> {
  const resp = await fetch(LLM_CONFIG.minimax.url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: LLM_CONFIG.minimax.model,
      messages: [
        { role: "system", content: "Answer questions with short phrases based on provided context. Use exact words from the context whenever possible." },
        { role: "user", content: prompt },
      ],
      max_tokens: 4096,
      temperature: 0.01,
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`MiniMax ${resp.status}: ${body.slice(0, 200)}`);
  }

  const data = await resp.json() as any;
  let text = data.choices?.[0]?.message?.content || "";
  text = text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  const answerMatch = text.match(/(?:^|\n)(?:Answer:\s*)(.*)/i);
  if (answerMatch) text = answerMatch[1]!.trim();
  text = text.replace(/^["']|["']$/g, "").trim();
  return text;
}

function buildAnswerPrompt(question: string, memories: string[], category: number): string {
  const context = memories.map((m, i) => `[${i + 1}] ${m}`).join("\n");

  const contextBlock = context;

  if (category === 5) {
    // Adversarial — answer is often "undefined" for events that never happened
    return `${contextBlock}

Based on the above context, answer the following question.
If the context does NOT contain information to answer this question, respond with exactly: undefined

Question: ${question} Short answer:`;
  }

  return `${contextBlock}

Based on the above context, write an answer in the form of a short phrase for the following question. Answer with exact words from the context whenever possible.

IMPORTANT: Each memory has a timestamp in [brackets]. If a memory says "yesterday" or "last week", compute the actual date from the timestamp. For example, if a memory dated [3 July 2023] says "I signed up yesterday", the answer is "2 July 2023".

Question: ${question} Short answer:`;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DialogTurn {
  speaker: string;
  dia_id: string;
  text: string;
  share_photo?: boolean;
  blip_caption?: string;
}

interface QAPair {
  question: string;
  answer: string;
  evidence: string[];
  category: number;
}

interface Conversation {
  sample_id: string;
  conversation: Record<string, any>;
  qa: QAPair[];
}

const CATEGORY_NAMES: Record<number, string> = {
  1: "single-hop",
  2: "multi-hop",
  3: "open-domain",
  4: "temporal",
  5: "adversarial",
};

// ---------------------------------------------------------------------------
// F1 scoring (SQuAD-style token overlap)
// ---------------------------------------------------------------------------

function tokenize(text: string): string[] {
  return String(text || "").toLowerCase().replace(/[^\w\s]/g, " ").split(/\s+/).filter(t => t.length > 0);
}

function computeF1(prediction: string, groundTruth: string): number {
  const predTokens = tokenize(prediction);
  const truthTokens = tokenize(groundTruth);
  if (predTokens.length === 0 && truthTokens.length === 0) return 1;
  if (predTokens.length === 0 || truthTokens.length === 0) return 0;
  const truthSet = new Set(truthTokens);
  const overlap = predTokens.filter(t => truthSet.has(t)).length;
  if (overlap === 0) return 0;
  const precision = overlap / predTokens.length;
  const recall = overlap / truthTokens.length;
  return (2 * precision * recall) / (precision + recall);
}

function computeExactMatch(prediction: string, groundTruth: string): number {
  return tokenize(prediction).join(" ") === tokenize(groundTruth).join(" ") ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Progress display
// ---------------------------------------------------------------------------

function progressBar(current: number, total: number, width = 30): string {
  const pct = total > 0 ? current / total : 0;
  const filled = Math.round(pct * width);
  const bar = "\u2588".repeat(filled) + "\u2591".repeat(width - filled);
  return `[${bar}] ${(pct * 100).toFixed(0).padStart(3)}% (${current}/${total})`;
}

function elapsed(startMs: number): string {
  const s = Math.floor((Date.now() - startMs) / 1000);
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return m > 0 ? `${m}m${sec}s` : `${sec}s`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  let limit = 0;
  let convFilter: string | null = null;
  let useLLM = true;
  let ingestOnly = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--limit" && args[i + 1]) limit = parseInt(args[i + 1]!, 10);
    if (args[i] === "--conv" && args[i + 1]) convFilter = args[i + 1]!;
    if (args[i] === "--no-llm") useLLM = false;
    if (args[i] === "--ingest-only") { ingestOnly = true; useLLM = false; }
    if (args[i] === "--llm" && args[i + 1]) { activeLLM = args[i + 1] as LLMProvider; }
  }

  if (useLLM) {
    const keyEnv = LLM_CONFIG[activeLLM].keyEnv;
    if (!process.env[keyEnv]) {
      console.error(`Set ${keyEnv} or use --no-llm for retrieval-only eval`);
      process.exit(1);
    }
  }

  // Load dataset
  const dataPath = join(QMD_DIR, "evaluate/locomo/locomo10.json");
  const data: Conversation[] = JSON.parse(readFileSync(dataPath, "utf-8"));
  const totalQA = data.reduce((n, c) => n + c.qa.length, 0);
  console.log(`\n  Dataset: ${data.length} conversations, ${totalQA} QA pairs`);
  console.log(`  Mode: ${ingestOnly ? "ingest only (build DB)" : useLLM ? `QMD recall + ${LLM_CONFIG[activeLLM].model} answer` : "QMD recall only (no LLM)"}`);
  if (convFilter) console.log(`  Filter: ${convFilter}`);
  if (limit) console.log(`  Limit: ${limit} questions per conversation`);
  console.log();

  let conversations = convFilter ? data.filter(c => c.sample_id === convFilter) : data;
  if (conversations.length === 0) {
    console.error(`No conversation found: ${convFilter}`);
    process.exit(1);
  }

  const allResults: Array<{
    sample_id: string;
    question: string;
    answer: string;
    prediction: string;
    memories: string[];
    memoriesFound: number;
    f1: number;
    em: number;
    category: number;
    categoryName: string;
    searchMs: number;
    answerMs: number;
  }> = [];

  // Helper: ingest all sessions for a conversation
  async function ingestConversation(db: Database, c: Record<string, any>, scope: string) {
    let sessionCount = 0;
    let memoryCount = 0;
    const ingestStart = Date.now();

    for (let s = 1; s <= 35; s++) {
      const turns: DialogTurn[] | undefined = c[`session_${s}`];
      const dateTime: string | undefined = c[`session_${s}_date_time`];
      if (!turns || !Array.isArray(turns) || turns.length === 0) continue;
      sessionCount++;

      for (const turn of turns) {
        let text = dateTime ? `[${dateTime}] ${turn.speaker}: ${turn.text}` : `${turn.speaker}: ${turn.text}`;
        if (turn.share_photo && turn.blip_caption) text += ` [shared photo: ${turn.blip_caption}]`;

        try {
          const r = await memoryStore(db, { text, scope });
          if (r.status === "created") memoryCount++;
        } catch { /* skip */ }
      }

      process.stdout.write(`\r    ${progressBar(sessionCount, 35)} | ${memoryCount} memories | ${elapsed(ingestStart)}`);
    }
    console.log(`\n    Done: ${sessionCount} sessions, ${memoryCount} memories in ${elapsed(ingestStart)}`);
  }

  const globalStart = Date.now();

  for (const conv of conversations) {
    const convStart = Date.now();
    console.log(`${"=".repeat(64)}`);
    console.log(`  ${conv.sample_id} | ${conv.qa.length} QA pairs | speakers: ${conv.conversation.speaker_a}, ${conv.conversation.speaker_b}`);
    console.log(`${"=".repeat(64)}`);

    // --- INGEST (persistent DB — skip if already ingested) ---
    const dbDir = join(QMD_DIR, "evaluate/locomo/dbs");
    if (!existsSync(dbDir)) mkdirSync(dbDir, { recursive: true });
    const dbPath = join(dbDir, `${conv.sample_id}.sqlite`);
    const dbExists = existsSync(dbPath);
    const db: Database = openDatabase(dbPath);
    initializeDatabase(db);

    const scope = conv.sample_id;
    const c = conv.conversation;

    if (dbExists) {
      // Check if memories exist
      const count = (db.prepare(`SELECT COUNT(*) as n FROM memories`).get() as any)?.n || 0;
      if (count > 0) {
        console.log(`\n  Phase 1: INGEST (cached — ${count} memories in ${dbPath})`);
      } else {
        // DB exists but empty — re-ingest
        console.log(`\n  Phase 1: INGEST (empty DB, re-ingesting)`);
        await ingestConversation(db, c, scope);
      }
    } else {
      console.log(`\n  Phase 1: INGEST (first run — embedding via ZeroEntropy)`);
      await ingestConversation(db, c, scope);
    }

    if (ingestOnly) {
      console.log(`\n    Ingest-only mode — skipping eval. DB saved: ${dbPath}`);
      db.close();
      continue;
    }

    // --- EVALUATE ---
    let qaList = conv.qa;
    if (limit > 0) qaList = qaList.slice(0, limit);

    console.log(`\n  Phase 2: EVALUATE (${qaList.length} questions)`);
    const evalStart = Date.now();
    let runningF1 = 0;
    let runningEM = 0;

    for (let i = 0; i < qaList.length; i++) {
      const qa = qaList[i]!;

      // --- RECALL ---
      const t0 = Date.now();
      let memories: Array<{ text: string; score: number }> = [];
      try {
        const recalled = await memoryRecall(db, { query: qa.question, limit: 10, scope });
        memories = recalled.map((m: any) => ({ text: m.text, score: m.score }));
      } catch { /* empty */ }
      const searchMs = Date.now() - t0;

      // --- ANSWER ---
      let prediction = "";
      let answerMs = 0;

      if (useLLM && memories.length > 0) {
        const t1 = Date.now();
        try {
          const prompt = buildAnswerPrompt(qa.question, memories.map(m => m.text), qa.category);
          prediction = await askLLM(prompt);
        } catch (e) {
          prediction = memories.map(m => m.text).join(" "); // fallback to raw memories
          process.stderr.write(`\n    [warn] MiniMax failed for q${i}: ${e}\n`);
        }
        answerMs = Date.now() - t1;
      } else {
        prediction = memories.map(m => m.text).join(" ");
      }

      const f1 = computeF1(prediction, qa.answer);
      const em = computeExactMatch(prediction, qa.answer);
      runningF1 += f1;
      runningEM += em;

      allResults.push({
        sample_id: conv.sample_id,
        question: qa.question,
        answer: qa.answer,
        prediction: prediction.slice(0, 300),
        memories: memories.map(m => m.text.slice(0, 120)),
        memoriesFound: memories.length,
        f1, em,
        category: qa.category,
        categoryName: CATEGORY_NAMES[qa.category] || "unknown",
        searchMs, answerMs,
      });

      // Progress every question
      const avgF1 = runningF1 / (i + 1);
      const line = [
        `\r    ${progressBar(i + 1, qaList.length)}`,
        `F1=${(avgF1 * 100).toFixed(1)}%`,
        `mem=${memories.length}`,
        `search=${searchMs}ms`,
        useLLM ? `llm=${answerMs}ms` : "",
        elapsed(evalStart),
      ].filter(Boolean).join(" | ");
      process.stdout.write(line);

      // Detailed output every 10 or on last
      if ((i + 1) % 10 === 0 || i === qaList.length - 1) {
        console.log(); // newline after progress bar
      }
    }

    console.log(`\n    ${conv.sample_id} done: F1=${(runningF1 / qaList.length * 100).toFixed(1)}% EM=${(runningEM / qaList.length * 100).toFixed(1)}% in ${elapsed(convStart)}`);

    db.close();
  }

  // --------------- FINAL REPORT ---------------
  const n = allResults.length;
  if (n === 0) { console.log("No results."); return; }

  const avgF1 = allResults.reduce((s, r) => s + r.f1, 0) / n;
  const avgEM = allResults.reduce((s, r) => s + r.em, 0) / n;
  const avgSearch = allResults.reduce((s, r) => s + r.searchMs, 0) / n;
  const avgAnswer = allResults.reduce((s, r) => s + r.answerMs, 0) / n;
  const avgMemories = allResults.reduce((s, r) => s + r.memoriesFound, 0) / n;

  console.log(`\n${"=".repeat(64)}`);
  console.log(`  FINAL RESULTS`);
  console.log(`${"=".repeat(64)}`);
  console.log(`  Questions:    ${n}`);
  console.log(`  F1:           ${(avgF1 * 100).toFixed(1)}%`);
  console.log(`  Exact Match:  ${(avgEM * 100).toFixed(1)}%`);
  console.log(`  Avg memories: ${avgMemories.toFixed(1)} per question`);
  console.log(`  Avg search:   ${avgSearch.toFixed(0)}ms`);
  if (useLLM) console.log(`  Avg answer:   ${avgAnswer.toFixed(0)}ms`);
  console.log(`  Total time:   ${elapsed(globalStart)}`);

  console.log(`\n  By category:`);
  const cats = [...new Set(allResults.map(r => r.category))].sort();
  for (const cat of cats) {
    const cr = allResults.filter(r => r.category === cat);
    const cf1 = cr.reduce((s, r) => s + r.f1, 0) / cr.length;
    const cem = cr.reduce((s, r) => s + r.em, 0) / cr.length;
    console.log(`    ${(CATEGORY_NAMES[cat] || String(cat)).padEnd(12)} (n=${String(cr.length).padStart(4)}): F1=${(cf1 * 100).toFixed(1).padStart(5)}%  EM=${(cem * 100).toFixed(1).padStart(5)}%`);
  }

  if (conversations.length > 1) {
    console.log(`\n  By conversation:`);
    for (const cid of [...new Set(allResults.map(r => r.sample_id))]) {
      const cr = allResults.filter(r => r.sample_id === cid);
      const cf1 = cr.reduce((s, r) => s + r.f1, 0) / cr.length;
      console.log(`    ${cid} (n=${cr.length}): F1=${(cf1 * 100).toFixed(1)}%`);
    }
  }

  // Top 5 best / worst
  const sorted = [...allResults].sort((a, b) => b.f1 - a.f1);
  console.log(`\n  Top 5 best:`);
  for (const r of sorted.slice(0, 5)) {
    console.log(`    F1=${(r.f1 * 100).toFixed(0).padStart(3)}% [${r.categoryName}] Q: ${r.question.slice(0, 50)}`);
    console.log(`          A: ${r.answer} | P: ${r.prediction.slice(0, 60)}`);
  }
  console.log(`\n  Top 5 worst:`);
  for (const r of sorted.slice(-5).reverse()) {
    console.log(`    F1=${(r.f1 * 100).toFixed(0).padStart(3)}% [${r.categoryName}] Q: ${r.question.slice(0, 50)}`);
    console.log(`          A: ${r.answer} | P: ${r.prediction.slice(0, 60)}`);
  }

  // Save
  const outPath = join(QMD_DIR, "evaluate/locomo/results.json");
  writeFileSync(outPath, JSON.stringify({
    config: { useLLM, model: useLLM ? LLM_CONFIG[activeLLM].model : "none", llm: activeLLM, limit, convFilter },
    summary: { avgF1, avgEM, avgSearch, avgAnswer, avgMemories, total: n },
    results: allResults,
  }, null, 2));
  console.log(`\n  Results saved: ${outPath}`);
}

main().catch(e => { console.error(e); process.exit(1); });
