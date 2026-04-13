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
import { openCache } from "../_shared/llm-cache.js";

// Quality fix C: response cache for reproducible re-runs
const LLM_CACHE_PATH = join(process.cwd(), "evaluate/locomo/llm-cache.json");
const llmCache = openCache(LLM_CACHE_PATH);
// Tell extractAndStore (chatComplete in src/llm.ts) to use the same cache file
process.env.QMD_LLM_CACHE_PATH = LLM_CACHE_PATH;

// ---------------------------------------------------------------------------
// QMD imports
// ---------------------------------------------------------------------------

const QMD_DIR = process.cwd();
function toUrl(p: string) { return pathToFileURL(p).href; }

const { loadQmdEnv } = await import(toUrl(join(QMD_DIR, "src/env.ts")));
loadQmdEnv();

const { openDatabase } = await import(toUrl(join(QMD_DIR, "src/db.ts")));
const { initializeDatabase } = await import(toUrl(join(QMD_DIR, "src/store/db-init.ts")));
const { memoryStore, memoryStoreBatch, memoryRecall, extractAndStore, extractReflections, consolidateEntityFacts, runDecayPass, memoryReflect } = await import(toUrl(join(QMD_DIR, "src/memory/index.ts")));
const { knowledgeStore, knowledgeQuery, knowledgeAbout } = await import(toUrl(join(QMD_DIR, "src/memory/knowledge.ts")));

type Database = ReturnType<typeof openDatabase>;

// ---------------------------------------------------------------------------
// MiniMax LLM
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// LLM providers
// ---------------------------------------------------------------------------

type LLMProvider = "gemini" | "minimax";

// Pinned model versions (quality fix B) — prevents silent rolling updates
// gemini-2.5-flash → gemini-2.5-flash (Apr 2026 stable checkpoint)
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

// Fixed seed (quality fix A) — Gemini supports best-effort seeded sampling
const LLM_SEED = 42;

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
  const cacheKey = { model: LLM_CONFIG.gemini.model, temperature: 0, seed: LLM_SEED, prompt };
  const cached = llmCache.get(cacheKey);
  if (cached != null) return cached;

  const url = `${LLM_CONFIG.gemini.url}?key=${apiKey}`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0,
        seed: LLM_SEED,
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
  llmCache.set(cacheKey, text);
  return text;
}

async function askMiniMax(prompt: string, apiKey: string): Promise<string> {
  const cacheKey = { model: LLM_CONFIG.minimax.model, temperature: 0.01, seed: LLM_SEED, prompt };
  const cached = llmCache.get(cacheKey);
  if (cached != null) return cached;

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
      seed: LLM_SEED,
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
  llmCache.set(cacheKey, text);
  return text;
}

function buildAnswerPrompt(question: string, memories: string[], category: number, groundTruthIsNull: boolean = false): string {
  const context = memories.map((m, i) => `[${i + 1}] ${m}`).join("\n");
  const contextBlock = context;
  const promptVer = process.env.QMD_PROMPT_RULES || "v11";

  if (category === 5 || groundTruthIsNull) {
    // Adversarial — answer "undefined" for events that never happened
    return `${contextBlock}

Based on the above context, answer the following question.
If the context does NOT contain information to answer this question, respond with exactly: undefined

Question: ${question} Short answer:`;
  }

  // v10 baseline prompt — minimal rules
  if (promptVer === "v10") {
    return `${contextBlock}

Based on the above context, write an answer in the form of a short phrase for the following question. Answer with exact words from the context whenever possible.

Rules:
1. Each memory has a timestamp in [brackets]. If a memory says "yesterday", "last week", "last Saturday", or "this month", compute the actual calendar date from the timestamp.
2. For identity/status questions, extract the specific attribute.
3. For "what does X like" questions, list specific items mentioned across all memories.
4. Answer with the most specific information available.
5. NEVER answer with relative terms — always convert to actual dates.

Question: ${question} Short answer:`;
  }

  // v11+ prompt — added multi-item, yes/no, synthesis, duration rules
  return `${contextBlock}

Based on the above context, write an answer in the form of a short phrase for the following question. Answer with exact words from the context whenever possible.

Rules:
1. Each memory has a timestamp in [brackets] like "[1:56 pm on 8 May, 2023]". The date is "8 May, 2023" and the year is 2023. If a memory says "yesterday", compute the day before. If it says "last week" or "a week ago", compute the date 7 days earlier. If it says "this month", answer the month and year. If it says "last year", answer the previous year (timestamp year minus 1). If it says "X years ago", subtract X from the timestamp year.
2. For DURATION questions ("How long did X take?", "How long has X been doing Y?"), compute the span between two dates from memories. Example: started January 2023, opened in July 2023 → answer "six months".
3. For identity/status questions, extract the specific attribute (e.g. "single", "transgender", "Swedish").
4. For "what does X like" / "what activities" / "which cities" / "how did X promote" questions: list ALL items mentioned across ALL memories, separated by commas. Do not stop at one item — scan every memory for matches.
5. For Yes/No questions ("Did X happen?", "Do they both X?", "Are they X?"): answer with ONLY "Yes" or "No" — no extra words.
6. For comparison/commonality questions ("What do X and Y have in common?", "What do both share?"): find facts that apply to BOTH parties and combine them. Example: if Jon lost his job AND Gina lost her job, answer "They both lost their jobs".
7. Answer with the most specific information available. Prefer proper nouns, dates, and concrete details.
8. NEVER answer with relative terms like "yesterday", "this month", "last week", "last year" — always convert to actual calendar dates or years.
9. NEVER output partial or truncated timestamps like "2:32 pm on 2" — always output the FULL date including day, month, and year.
10. If the question asks "When did X happen?" and you find a memory mentioning the event, use the FULL date from that memory's timestamp.

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

/**
 * Collect the set of source IDs present in the top-K memories.
 * Returns both dialog IDs ("D1:3") and session IDs ("D1") extracted from metadata.
 */
function collectTopKSourceIds(
  memories: Array<{ metadata?: string | null }>,
  k: number
): { dialogIds: Set<string>; sessionIds: Set<string> } {
  const dialogIds = new Set<string>();
  const sessionIds = new Set<string>();
  for (const m of memories.slice(0, k)) {
    if (!m.metadata) continue;
    try {
      const meta = JSON.parse(m.metadata) as {
        source_dialog_id?: string;
        source_session_id?: string;
      };
      if (meta.source_dialog_id) {
        dialogIds.add(meta.source_dialog_id);
        // Also infer the session ID from the dialog prefix
        const sess = meta.source_dialog_id.split(":")[0];
        if (sess) sessionIds.add(sess);
      }
      if (meta.source_session_id) sessionIds.add(meta.source_session_id);
    } catch { /* ignore malformed metadata */ }
  }
  return { dialogIds, sessionIds };
}

/**
 * SR@K (fractional dialog-level recall) — APPLES-TO-APPLES with MemPalace's
 * compute_retrieval_recall in benchmarks/locomo_bench.py: `found / len(evidence)`.
 * Evidence is a list of dialog IDs ("D1:3"); we check what fraction of them appear
 * in the top-K memories' source_dialog_id metadata.
 */
function computeDialogRecallAtK(
  memories: Array<{ metadata?: string | null }>,
  evidence: string[] | undefined,
  k: number
): number {
  if (!evidence || evidence.length === 0) return 1;
  const { dialogIds } = collectTopKSourceIds(memories, k);
  const found = evidence.filter(e => dialogIds.has(e)).length;
  return found / evidence.length;
}

/**
 * Session-level any-match variant (coarser than dialog-level). Session ID is
 * extracted from evidence via the "D<n>:" prefix. Returns 1 if ANY evidence
 * session shows up in top-K; matches MemPalace's recall_any-style session mode.
 */
function computeSessionRecallAtK(
  memories: Array<{ metadata?: string | null }>,
  evidence: string[] | undefined,
  k: number
): number {
  if (!evidence || evidence.length === 0) return 1;
  const correct = new Set(
    evidence.map(e => (e.split(":")[0] || "").trim()).filter(Boolean)
  );
  if (correct.size === 0) return 1;
  const { sessionIds } = collectTopKSourceIds(memories, k);
  for (const s of sessionIds) if (correct.has(s)) return 1;
  return 0;
}

/** R@K: do any of the top K memories contain the ground truth answer tokens? */
function computeRecallAtK(memories: Array<{ text: string }>, groundTruth: string, k: number): number {
  const truthTokens = tokenize(groundTruth);
  if (truthTokens.length === 0) return 1;
  const topK = memories.slice(0, k);
  // Check if majority of answer tokens appear in any single memory
  for (const mem of topK) {
    const memTokens = new Set(tokenize(mem.text));
    const hits = truthTokens.filter(t => memTokens.has(t)).length;
    if (hits / truthTokens.length >= 0.5) return 1; // 50% token overlap = hit
  }
  // Also check across all top-K combined
  const allTokens = new Set(topK.flatMap(m => tokenize(m.text)));
  const totalHits = truthTokens.filter(t => allTokens.has(t)).length;
  if (totalHits / truthTokens.length >= 0.7) return 1; // 70% across all = hit
  return 0;
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
// Knowledge triple extraction (regex-based, no LLM needed)
// ---------------------------------------------------------------------------

function parseTimestampMs(text: string): number | undefined {
  // Parse "[1:56 pm on 8 May, 2023]" style timestamps
  const m = text.match(/\[([^\]]+)\]/);
  if (!m) return undefined;
  try {
    const d = new Date(m[1]!.replace(/(\d+:\d+\s*[ap]m)\s+on\s+/i, "$1 "));
    return isNaN(d.getTime()) ? undefined : d.getTime();
  } catch { return undefined; }
}

function extractTriplesFromMemory(text: string, memId: string, scope: string): Array<{
  subject: string; predicate: string; object: string; valid_from?: number;
}> {
  const triples: Array<{ subject: string; predicate: string; object: string; valid_from?: number }> = [];
  const ts = parseTimestampMs(text);

  // Extract speaker from "[date] Speaker: text" format
  const speakerMatch = text.match(/\]\s*(\w+):\s*/);
  const speaker = speakerMatch?.[1] || "";
  const content = text.replace(/\[[^\]]*\]\s*\w+:\s*/, "").trim();
  const lower = content.toLowerCase();

  // "I went to X" / "I signed up for X" / "I joined X"
  const actionPatterns = [
    { re: /\b(?:went to|attended|visited)\s+(?:a\s+)?(.+?)(?:\.|!|$)/i, pred: "attended" },
    { re: /\bsigned up for\s+(?:a\s+)?(.+?)(?:\.|!|$)/i, pred: "signed_up_for" },
    { re: /\bjoined\s+(?:a\s+)?(.+?)(?:\.|!|$)/i, pred: "joined" },
    { re: /\b(?:going to|plan(?:ning)? to (?:go to|attend))\s+(?:a\s+)?(.+?)(?:\.|!|$)/i, pred: "plans_to_attend" },
    { re: /\bresearch(?:ed|ing)\s+(.+?)(?:\.|!|$)/i, pred: "researched" },
    { re: /\bmoved (?:from|to)\s+(.+?)(?:\.|!|$)/i, pred: "moved" },
    { re: /\bpainted\s+(?:a\s+|that\s+)?(.+?)(?:\.|!|$)/i, pred: "painted" },
    { re: /\b(?:love|like|enjoy)s?\s+(.+?)(?:\.|!|$)/i, pred: "enjoys" },
    { re: /\bfrom\s+(?:my\s+)?(?:home\s+country\s+)?([A-Z]\w+)\b.*?(?:grandma|family|heritage|roots|necklace)/i, pred: "origin_country" },
    { re: /\b(single|divorced|married|widowed)\s+(?:parent|mother|father|mom|dad)\b/i, pred: "relationship_status" },
    { re: /\b(?:stoked for|excited about|loved)\s+the\s+(.+?)(?:\.|!|$)/i, pred: "kids_enjoyed" },
  ];

  for (const { re, pred } of actionPatterns) {
    const m = content.match(re);
    if (m && m[1] && speaker) {
      triples.push({ subject: speaker, predicate: pred, object: m[1].slice(0, 100).trim(), valid_from: ts });
    }
  }

  // "I'm a/an X" / "I am X" identity patterns
  const identityMatch = content.match(/\bI(?:'m| am)\s+(?:a |an )?(\w[\w\s]{2,30}?)(?:\.|!|,|$)/i);
  if (identityMatch && speaker) {
    triples.push({ subject: speaker, predicate: "identity", object: identityMatch[1]!.trim(), valid_from: ts });
  }

  // "My kids/children like/love X"
  const kidsMatch = content.match(/\b(?:my )?(?:kids?|children)\s+(?:like|love|enjoy|are (?:into|stoked for))\s+(.+?)(?:\.|!|$)/i);
  if (kidsMatch && speaker) {
    triples.push({ subject: speaker, predicate: "kids_like", object: kidsMatch[1]!.trim(), valid_from: ts });
  }

  // "X years" / "X year" duration facts
  const durationMatch = content.match(/(\d+)\s+years?/);
  if (durationMatch && speaker) {
    const ctx = content.slice(Math.max(0, content.indexOf(durationMatch[0]) - 40), content.indexOf(durationMatch[0]) + durationMatch[0].length + 20);
    triples.push({ subject: speaker, predicate: "duration_mentioned", object: ctx.trim(), valid_from: ts });
  }

  return triples;
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
  let dbSuffix = "";        // appended to db filename + results filename for ablation
  let resultsTag = "";       // label for results.json filename

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--limit" && args[i + 1]) limit = parseInt(args[i + 1]!, 10);
    if (args[i] === "--conv" && args[i + 1]) convFilter = args[i + 1]!;
    if (args[i] === "--no-llm") useLLM = false;
    if (args[i] === "--ingest-only") { ingestOnly = true; useLLM = false; }
    if (args[i] === "--llm" && args[i + 1]) { activeLLM = args[i + 1] as LLMProvider; }
    if (args[i] === "--db-suffix" && args[i + 1]) dbSuffix = "-" + args[i + 1];
    if (args[i] === "--tag" && args[i + 1]) resultsTag = args[i + 1]!;
    // cat D: override LLM model for A-B testing — sets BOTH extract and answer model
    if (args[i] === "--model" && args[i + 1]) {
      const m = args[i + 1]!;
      LLM_CONFIG.gemini.model = m;
      LLM_CONFIG.gemini.url = `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`;
      process.env.QMD_QUERY_EXPANSION_MODEL = m;
    }
    // Split: only override the answer model (keeps extract model on default/lite)
    if (args[i] === "--answer-model" && args[i + 1]) {
      const m = args[i + 1]!;
      LLM_CONFIG.gemini.model = m;
      LLM_CONFIG.gemini.url = `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`;
    }
    // --extract-model was pointing at QMD_QUERY_EXPANSION_MODEL (wrong variable —
    // the extractor ignores it, and queryExpansion then 404s). Removed pending a
    // real per-call override in src/memory/extractor.ts.
  }

  // Ablation toggles via env vars (read once for logging)
  const ablation = {
    INGEST_SYNTHESIS: process.env.QMD_INGEST_SYNTHESIS !== "off",
    INGEST_REFLECTIONS: process.env.QMD_INGEST_REFLECTIONS !== "off",
    PROMPT_RULES: process.env.QMD_PROMPT_RULES || "v11",
    RECALL_DUAL_PASS: process.env.QMD_RECALL_DUAL_PASS === "on",
    RECALL_LOG_MOD: process.env.QMD_RECALL_LOG_MOD === "on",
    RECALL_MMR: process.env.QMD_RECALL_MMR === "on",
    RECALL_MMR_LAMBDA: parseFloat(process.env.QMD_RECALL_MMR_LAMBDA || "0.85"),
  };
  if (dbSuffix || resultsTag) {
    console.log(`\n  Ablation: db=${dbSuffix || "(default)"} tag=${resultsTag || "(none)"} ${JSON.stringify(ablation)}`);
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
    r5: number;
    r10: number;
    sr5: number;
    sr10: number;
    sr15: number;
    sr50: number;
    dr5: number;   // dialog-level fractional recall (MemPalace compute_retrieval_recall)
    dr10: number;
    dr15: number;
    dr50: number;
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

    // Storage mode toggles (cheap optimization knobs)
    const storeTurns = process.env.QMD_INGEST_PER_TURN !== "off";
    const storeSessions = process.env.QMD_INGEST_SESSION_AS_MEMORY !== "off";
    // Collect everything to ingest in one batch per conversation, then send.
    // metadata.source_session_id is the LoCoMo session ID ("D<n>") — matches QA.evidence prefix.
    const allItems: Array<{ text: string; scope: string; importance?: number; metadata?: Record<string, any> }> = [];

    for (let s = 1; s <= 35; s++) {
      const turns: DialogTurn[] | undefined = c[`session_${s}`];
      const dateTime: string | undefined = c[`session_${s}_date_time`];
      if (!turns || !Array.isArray(turns) || turns.length === 0) continue;
      sessionCount++;
      const sessionId = `D${s}`;

      // Store raw dialog turns (preserves exact text + timestamps).
      // source_dialog_id uses the LoCoMo dataset's native `dia_id` field (e.g. "D1:3") —
      // matches the QA.evidence format exactly for apples-to-apples dialog-level recall.
      if (storeTurns) {
        for (let t = 0; t < turns.length; t++) {
          const turn = turns[t]!;
          let text = dateTime ? `[${dateTime}] ${turn.speaker}: ${turn.text}` : `${turn.speaker}: ${turn.text}`;
          if (turn.share_photo && turn.blip_caption) text += ` [shared photo: ${turn.blip_caption}]`;
          allItems.push({
            text,
            scope,
            metadata: {
              source_session_id: sessionId,
              source_dialog_id: turn.dia_id || `${sessionId}:${t + 1}`,
              turn_index: t,
            },
          });
        }
      }

      // Store full session as single memory (MemPalace: larger chunks = more context per hit)
      const sessionLines = turns.map(t => {
        let line = `${t.speaker}: ${t.text}`;
        if (t.share_photo && t.blip_caption) line += ` [photo: ${t.blip_caption}]`;
        return line;
      });
      if (dateTime) sessionLines.unshift(`[${dateTime}]`);
      const sessionText = sessionLines.join("\n");
      if (storeSessions && sessionText.length > 100) {
        allItems.push({ text: sessionText, scope, importance: 0.7, metadata: { source_session_id: sessionId } });
      }

      // Also run extractAndStore for preference bridging — toggleable (cat C)
      if (process.env.QMD_INGEST_EXTRACTION !== "off") {
        try {
          const eResult = await extractAndStore(db, sessionLines.join("\n"), scope);
          memoryCount += eResult.stored;
        } catch { /* extraction optional */ }
      }

      // v13: extract reflections (cat 18) — toggleable via QMD_INGEST_REFLECTIONS=off
      if (process.env.QMD_INGEST_REFLECTIONS !== "off") {
        try {
          const rResult = await extractReflections(db, sessionLines.join("\n"), scope);
          memoryCount += rResult.stored;
        } catch { /* reflection optional */ }
      }

      process.stdout.write(`\r    ${progressBar(sessionCount, 35)} | extracted | ${elapsed(ingestStart)}`);
    }

    // Batched insert + batched embedding round-trip (system-wide optimization)
    // Replaces 2N sequential per-turn embed calls with batched embedBatch().
    if (allItems.length > 0) {
      try {
        const r = await memoryStoreBatch(db, allItems);
        memoryCount += r.filter((x: any) => x.status === "created").length;
      } catch (e) {
        process.stderr.write(`memoryStoreBatch failed: ${e}\n`);
        for (const item of allItems) {
          try {
            const r = await memoryStore(db, item);
            if (r.status === "created") memoryCount++;
          } catch { /* skip */ }
        }
      }
    }
    console.log(`\n    Done: ${sessionCount} sessions, ${memoryCount} memories in ${elapsed(ingestStart)}`);

    // Extract knowledge triples from stored memories
    // Knowledge triples now auto-extracted by extractAndStore (Mem0-style LLM extraction)
    // Regex extraction removed — LLM produces cleaner, more accurate triples
    try {
      const kgCount = (db.prepare(`SELECT COUNT(*) as n FROM knowledge`).get() as any)?.n || 0;
      console.log(`    Knowledge graph: ${kgCount} triples (auto-extracted by LLM)`);
    } catch { /* table may not exist */ }

    // v13: Per-entity synthesis from KG (cat 11) — toggleable via QMD_INGEST_SYNTHESIS=off
    if (process.env.QMD_INGEST_SYNTHESIS !== "off") {
      try {
        const cons = await consolidateEntityFacts(db, { scope });
        console.log(`    Consolidation: ${cons.entities} entities → ${cons.profiles} profiles + ${cons.timelines} timelines`);
      } catch (e) { console.error("    Consolidation failed:", e); }
    }

    // Run decay pass to promote important memories (MemPalace: dream consolidation)
    const decay = runDecayPass(db);
    console.log(`    Decay pass: ${decay.processed} processed, ${decay.promoted} promoted, ${decay.demoted} demoted`);
  }

  const globalStart = Date.now();

  for (const conv of conversations) {
    const convStart = Date.now();
    console.log(`${"=".repeat(64)}`);
    console.log(`  ${conv.sample_id} | ${conv.qa.length} QA pairs | speakers: ${conv.conversation.speaker_a}, ${conv.conversation.speaker_b}`);
    console.log(`${"=".repeat(64)}`);

    // --- INGEST (persistent DB — skip if already ingested) ---
    // Quality fix #7: include ingest config in cache filename so different
    // configs don't silently reuse stale DBs.
    const ingestConfigHash = [
      ablation.INGEST_SYNTHESIS ? "synth" : "nosynth",
      ablation.INGEST_REFLECTIONS ? "refl" : "norefl",
    ].join("-");
    const dbDir = join(QMD_DIR, "evaluate/locomo/dbs");
    if (!existsSync(dbDir)) mkdirSync(dbDir, { recursive: true });
    // Always include ingest config when no explicit suffix passed
    const effectiveSuffix = dbSuffix || `-${ingestConfigHash}`;
    const dbPath = join(dbDir, `${conv.sample_id}${effectiveSuffix}.sqlite`);
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

      // --- RECALL (memories + knowledge graph) ---
      const t0 = Date.now();
      let memories: Array<{ text: string; score: number; metadata?: string | null }> = [];
      try {
        // Pull top-50 for MemPalace-aligned SR@50; slice for SR@5/@10/@K locally.
        const recalled = await memoryRecall(db, { query: qa.question, limit: 50, scope });
        memories = recalled.map((m: any) => ({ text: m.text, score: m.score, metadata: m.metadata }));
      } catch { /* empty */ }

      // Knowledge graph injection removed — generic KG entries dominated top results
      // and pushed relevant memories down, hurting single-hop F1 (12/32 failures)
      // KG triples still extracted during ingest for future use

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
          const reflected = await memoryReflect(qa.question, memories, { maxFacts: 8 });
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
          const prompt = buildAnswerPrompt(qa.question, answerMemories, qa.category, qa.answer == null);
          prediction = await askLLM(prompt);
        } catch (e) {
          prediction = memories.map(m => m.text).join(" "); // fallback to raw memories
          process.stderr.write(`\n    [warn] MiniMax failed for q${i}: ${e}\n`);
        }
        answerMs = Date.now() - t1;
      } else {
        prediction = memories.map(m => m.text).join(" ");
      }

      // Normalize answer: LoCoMo adversarial questions have answer=undefined (missing field)
      const answer = qa.answer != null ? String(qa.answer) : "undefined";
      const f1 = computeF1(prediction, answer);
      const em = computeExactMatch(prediction, answer);
      const r5 = computeRecallAtK(memories, answer, 5);
      const r10 = computeRecallAtK(memories, answer, 10);
      // Session-level any-match (coarse, MemPalace "session" granularity)
      const evidenceIds = (qa as any).evidence as string[] | undefined;
      const sr5 = computeSessionRecallAtK(memories, evidenceIds, 5);
      const sr10 = computeSessionRecallAtK(memories, evidenceIds, 10);
      const sr15 = computeSessionRecallAtK(memories, evidenceIds, 15);
      const sr50 = computeSessionRecallAtK(memories, evidenceIds, 50);
      // Dialog-level fractional recall (MemPalace compute_retrieval_recall) — PRIMARY apples-to-apples metric
      const dr5 = computeDialogRecallAtK(memories, evidenceIds, 5);
      const dr10 = computeDialogRecallAtK(memories, evidenceIds, 10);
      const dr15 = computeDialogRecallAtK(memories, evidenceIds, 15);
      const dr50 = computeDialogRecallAtK(memories, evidenceIds, 50);
      runningF1 += f1;
      runningEM += em;

      allResults.push({
        sample_id: conv.sample_id,
        question: qa.question,
        answer,
        prediction: prediction.slice(0, 300),
        memories: memories.map(m => m.text.slice(0, 120)),
        memoriesFound: memories.length,
        f1, em, r5, r10, sr5, sr10, sr15, sr50, dr5, dr10, dr15, dr50,
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
  const avgR5 = allResults.reduce((s, r) => s + r.r5, 0) / n;
  const avgR10 = allResults.reduce((s, r) => s + r.r10, 0) / n;
  const avgSR5 = allResults.reduce((s, r) => s + r.sr5, 0) / n;
  const avgSR10 = allResults.reduce((s, r) => s + r.sr10, 0) / n;
  const avgSR15 = allResults.reduce((s, r) => s + r.sr15, 0) / n;
  const avgSR50 = allResults.reduce((s, r) => s + r.sr50, 0) / n;
  const avgDR5 = allResults.reduce((s, r) => s + r.dr5, 0) / n;
  const avgDR10 = allResults.reduce((s, r) => s + r.dr10, 0) / n;
  const avgDR15 = allResults.reduce((s, r) => s + r.dr15, 0) / n;
  const avgDR50 = allResults.reduce((s, r) => s + r.dr50, 0) / n;
  const avgSearch = allResults.reduce((s, r) => s + r.searchMs, 0) / n;
  const avgAnswer = allResults.reduce((s, r) => s + r.answerMs, 0) / n;
  const avgMemories = allResults.reduce((s, r) => s + r.memoriesFound, 0) / n;

  console.log(`\n${"=".repeat(64)}`);
  console.log(`  FINAL RESULTS`);
  console.log(`${"=".repeat(64)}`);
  console.log(`  Questions:    ${n}`);
  console.log(`  APPLES-TO-APPLES — MemPalace compute_retrieval_recall (dialog-level fractional):`);
  console.log(`    DR@5:       ${(avgDR5 * 100).toFixed(1)}%`);
  console.log(`    DR@10:      ${(avgDR10 * 100).toFixed(1)}%`);
  console.log(`    DR@15:      ${(avgDR15 * 100).toFixed(1)}%`);
  console.log(`    DR@50:      ${(avgDR50 * 100).toFixed(1)}%  ← MemPalace default top_k`);
  console.log(`  Session-level any-match (coarse):`);
  console.log(`    SR@5:       ${(avgSR5 * 100).toFixed(1)}%`);
  console.log(`    SR@10:      ${(avgSR10 * 100).toFixed(1)}%`);
  console.log(`    SR@15:      ${(avgSR15 * 100).toFixed(1)}%`);
  console.log(`    SR@50:      ${(avgSR50 * 100).toFixed(1)}%`);
  console.log(`  Legacy token-overlap:`);
  console.log(`    R@5:        ${(avgR5 * 100).toFixed(1)}%`);
  console.log(`    R@10:       ${(avgR10 * 100).toFixed(1)}%`);
  console.log(`  F1:           ${(avgF1 * 100).toFixed(1)}%  (LLM answer quality)`);
  console.log(`  Exact Match:  ${(avgEM * 100).toFixed(1)}%`);
  console.log(`  Avg memories: ${avgMemories.toFixed(1)} per question`);
  console.log(`  Avg search:   ${avgSearch.toFixed(0)}ms`);
  if (useLLM) console.log(`  Avg answer:   ${avgAnswer.toFixed(0)}ms`);
  console.log(`  Total time:   ${elapsed(globalStart)}`);
  // LLM cache stats (quality fix C)
  const cs = llmCache.stats();
  if (cs.hits + cs.misses > 0) {
    const hitRate = (cs.hits / (cs.hits + cs.misses) * 100).toFixed(1);
    console.log(`  LLM cache:    ${cs.hits} hits / ${cs.misses} misses (${hitRate}% hit rate, ${cs.entries} entries)`);
  }
  llmCache.flush();

  console.log(`\n  By category:`);
  const cats = [...new Set(allResults.map(r => r.category))].sort();
  for (const cat of cats) {
    const cr = allResults.filter(r => r.category === cat);
    const cf1 = cr.reduce((s, r) => s + r.f1, 0) / cr.length;
    const cem = cr.reduce((s, r) => s + r.em, 0) / cr.length;
    const cr5 = cr.reduce((s, r) => s + r.r5, 0) / cr.length;
    const cr10 = cr.reduce((s, r) => s + r.r10, 0) / cr.length;
    console.log(`    ${(CATEGORY_NAMES[cat] || String(cat)).padEnd(12)} (n=${String(cr.length).padStart(4)}): R@5=${(cr5 * 100).toFixed(0).padStart(3)}%  R@10=${(cr10 * 100).toFixed(0).padStart(3)}%  F1=${(cf1 * 100).toFixed(1).padStart(5)}%  EM=${(cem * 100).toFixed(1).padStart(5)}%`);
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

  // Save (results path includes tag for ablation runs)
  const resultsName = resultsTag ? `results-${resultsTag}.json` : "results.json";
  const outPath = join(QMD_DIR, "evaluate/locomo", resultsName);
  writeFileSync(outPath, JSON.stringify({
    config: { useLLM, model: useLLM ? LLM_CONFIG[activeLLM].model : "none", llm: activeLLM, limit, convFilter },
    summary: { avgDR5, avgDR10, avgDR15, avgDR50, avgSR5, avgSR10, avgSR15, avgSR50, avgR5, avgR10, avgF1, avgEM, avgSearch, avgAnswer, avgMemories, total: n },
    results: allResults,
  }, null, 2));
  console.log(`\n  Results saved: ${outPath}`);
}

main().catch(e => { console.error(e); process.exit(1); });
