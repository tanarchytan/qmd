/**
 * LoCoMo evaluation: Lotl memory retrieval + MiniMax answering.
 *
 * Usage:
 *   npx tsx evaluate/locomo/eval.mts [--limit N] [--conv SAMPLE_ID] [--no-llm]
 *
 * Env:
 *   MINIMAX_API_KEY  — MiniMax API key (required unless --no-llm)
 *
 * Flow per question:
 *   1. Lotl memoryRecall → top 10 memories
 *   2. MiniMax reads memories → generates answer
 *   3. Score answer vs ground truth (F1 + exact match)
 */

import { readFileSync, writeFileSync, renameSync, rmSync, mkdtempSync, existsSync, mkdirSync } from "fs";
import { join, dirname, resolve as pathResolve } from "path";
import { tmpdir } from "os";
import { pathToFileURL } from "url";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { openCache } from "../../src/llm/cache.js";

// Default LOTL_RECALL_NO_TOUCH=on for eval — must be set before memory imports
// so recall never bumps access_count. Opt-out for production-like runs:
// LOTL_RECALL_NO_TOUCH=off. See evaluate/longmemeval/eval.mts for context.
if (process.env.LOTL_RECALL_NO_TOUCH === undefined) process.env.LOTL_RECALL_NO_TOUCH = "on";

// Quality fix C: response cache for reproducible re-runs
// Path overridable via LOTL_LLM_CACHE_PATH — useful for running alternative
// model stacks (gemma, etc.) without polluting the canonical llama/qwen cache.
const LLM_CACHE_PATH = process.env.LOTL_LLM_CACHE_PATH || join(process.cwd(), "evaluate/locomo/llm-cache.json");
const llmCache = openCache(LLM_CACHE_PATH);
// Tell extractAndStore (chatComplete in src/llm.ts) to use the same cache file
process.env.LOTL_LLM_CACHE_PATH = LLM_CACHE_PATH;

// ---------------------------------------------------------------------------
// Lotl imports
// ---------------------------------------------------------------------------

const LOTL_DIR = process.cwd();
function toUrl(p: string) { return pathToFileURL(p).href; }

const { loadQmdEnv } = await import(toUrl(join(LOTL_DIR, "src/env.ts")));
loadQmdEnv();

const { openDatabase } = await import(toUrl(join(LOTL_DIR, "src/db.ts")));
const { initializeDatabase } = await import(toUrl(join(LOTL_DIR, "src/store/db-init.ts")));
const { memoryStore, memoryStoreBatch, memoryRecall, extractAndStore, extractReflections, consolidateEntityFacts, runDecayPass, memoryReflect } = await import(toUrl(join(LOTL_DIR, "src/memory/index.ts")));
const { knowledgeStore, knowledgeQuery, knowledgeAbout } = await import(toUrl(join(LOTL_DIR, "src/memory/knowledge.ts")));

type Database = ReturnType<typeof openDatabase>;

// ---------------------------------------------------------------------------
// MiniMax LLM
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// LLM providers
// ---------------------------------------------------------------------------

type LLMProvider = "gemini" | "minimax" | "poe" | "lmstudio";

// Pinned model versions (quality fix B) — prevents silent rolling updates.
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
  // Poe OpenAI-compatible endpoint — model override via LOTL_POE_MODEL (default gpt-4o-mini for generation).
  poe: {
    url: "https://api.poe.com/v1/chat/completions",
    model: process.env.LOTL_POE_MODEL || "gpt-4o-mini",
    keyEnv: "POE_API_KEY",
  },
  // LM Studio (local OpenAI-compatible). Same wiring as evaluate/longmemeval/eval.mts.
  // See evaluate/longmemeval/lmstudio-two-pass.sh for model-swap orchestration.
  lmstudio: {
    url: `http://${process.env.LOTL_LMSTUDIO_HOST || "10.0.0.105:1234"}/v1/chat/completions`,
    model: process.env.LOTL_LMSTUDIO_GEN_MODEL || "meta-llama-3.1-8b-instruct",
    keyEnv: "LOTL_LMSTUDIO_KEY",
  },
};

const LLM_SEED = 42;

let activeLLM: LLMProvider = "gemini";
// Optional judge provider (--judge) + per-call model override (--judge-model).
// Implements Mem0-style CORRECT/WRONG semantic grading (see HYBRID_HARNESS.md).
let judgeProvider: LLMProvider | null = null;
let judgeModelOverride: string | null = null;

async function askLLM(
  prompt: string,
  provider: LLMProvider = activeLLM,
  maxTokens: number = 256,
  modelOverride?: string,
  responseFormat?: Record<string, unknown>,
): Promise<string> {
  const cfg = LLM_CONFIG[provider];
  const apiKey = process.env[cfg.keyEnv];
  if (!apiKey) throw new Error(`${cfg.keyEnv} not set`);
  const model = modelOverride || cfg.model;
  if (provider === "gemini") return askGemini(prompt, apiKey);
  if (provider === "minimax") return askMiniMax(prompt, apiKey);
  if (provider === "poe") return askOpenAICompat(prompt, apiKey, cfg.url, model, maxTokens, responseFormat);
  if (provider === "lmstudio") return askOpenAICompat(prompt, apiKey || "lm-studio", cfg.url, model, maxTokens, responseFormat);
  throw new Error(`LLM provider not supported: ${provider}`);
}

// JSON Schema forcing valid judge output on schema-aware backends (lmstudio,
// poe). Fixes the 10-13% unparseable rate observed with gemma-4-26b-a4b at
// n=200. Gemini doesn't honor response_format so it falls back to the free-
// form text parse.
const JUDGE_RESPONSE_SCHEMA = {
  type: "json_schema",
  json_schema: {
    name: "verdict",
    strict: true,
    schema: {
      type: "object",
      properties: { correct: { type: "boolean" } },
      required: ["correct"],
      additionalProperties: false,
    },
  },
};

async function askOpenAICompat(
  prompt: string,
  apiKey: string,
  url: string,
  model: string,
  maxTokens: number = 256,
  responseFormat?: Record<string, unknown>,
): Promise<string> {
  // Include maxTokens in the key so thinking-model empty-content entries
  // cached at a smaller budget don't shadow valid results at a larger budget.
  const cacheKey = { model, temperature: 0, seed: LLM_SEED, max_tokens: maxTokens, prompt };
  const cached = llmCache.get(cacheKey);
  if (cached != null) return cached;
  const body: Record<string, unknown> = {
    model,
    messages: [{ role: "user", content: prompt }],
    temperature: 0,
    seed: LLM_SEED,
    max_tokens: maxTokens,
  };
  if (responseFormat) body.response_format = responseFormat;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(`${model} ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  const data = await resp.json() as any;
  let text = (data.choices?.[0]?.message?.content || "").replace(/^["']|["']$/g, "").trim();
  llmCache.set(cacheKey, text);
  return text;
}

// LLM-as-judge — two modes, selected via LOTL_LOCOMO_JUDGE=strict|lenient (default: lenient for back-compat).
//
//   "lenient" (legacy) — Mem0/HYBRID_HARNESS.md style, "touches on topic = CORRECT".
//     Produces the 6.9× leniency ratio the locomo-audit repo identified
//     (62.8% false-CORRECT rate on adversarial vague-but-topical answers).
//     Kept as default to preserve continuity with prior LoCoMo results.
//
//   "strict" (audit-corrected) — same prompt shape as evaluate/longmemeval/eval.mts.
//     "same facts as gold" + "missing any required fact = INCORRECT". Temporal
//     format leniency kept ("May 7th" vs "7 May" still CORRECT). Use this for
//     trustworthy QA accuracy. Enable via LOTL_LOCOMO_JUDGE=strict.
const JUDGE_SYSTEM_PROMPT_LENIENT =
  "You are a grader. You will be given a question, a gold answer, and a predicted answer.\n\n" +
  "Judge whether the predicted answer is CORRECT or WRONG.\n\n" +
  "Be generous: if the predicted answer touches the same topic/facts as the gold, mark CORRECT — " +
  "even if phrasing, format, or length differ. Only mark WRONG if the predicted answer contradicts " +
  "the gold, hallucinates, or fails to address the question.\n\n" +
  "For adversarial questions (gold is a refusal like 'not mentioned' or 'no information available'), " +
  "mark CORRECT only if the prediction also refuses / says insufficient information.\n\n" +
  "Reply on one line with a JSON object: {\"correct\": true|false}";
const JUDGE_SYSTEM_PROMPT_STRICT =
  "You are a strict but fair grader. Given a question, a gold-standard answer, and a candidate answer, decide whether the candidate answer is factually equivalent to the gold. " +
  "CORRECT if the candidate expresses the same facts as the gold (different wording or extra non-contradictory detail is fine). " +
  "Temporal format variations like 'May 7th' vs '7 May' are CORRECT when they refer to the same date. " +
  "INCORRECT if any required fact is missing, contradicted, or has a different value. " +
  "For adversarial questions (gold is a refusal like 'not mentioned' or 'no information available'), mark CORRECT only if the prediction also refuses / says insufficient information. " +
  "Respond on one line with a single JSON object: {\"correct\": true|false, \"reason\": \"<short sentence>\"}";
const JUDGE_SYSTEM_PROMPT =
  (process.env.LOTL_LOCOMO_JUDGE || "lenient") === "strict"
    ? JUDGE_SYSTEM_PROMPT_STRICT
    : JUDGE_SYSTEM_PROMPT_LENIENT;

async function askJudge(question: string, predicted: string, gold: string): Promise<number | null> {
  if (!judgeProvider) return null;
  const userMsg =
    `QUESTION: ${question.trim()}\n\n` +
    `GOLD ANSWER: ${gold.trim()}\n\n` +
    `PREDICTED ANSWER: ${predicted.trim()}\n\n` +
    `Respond with the JSON object only.`;
  const fullPrompt = `${JUDGE_SYSTEM_PROMPT}\n\n${userMsg}`;
  try {
    // LM Studio thinking models (qwen3.6-35b-a3b) burn 150+ reasoning_tokens
    // before emitting the verdict content. Bump cap to 768 so `content` isn't
    // starved. Override via LOTL_JUDGE_MAX_TOKENS for other models.
    const envCap = Number(process.env.LOTL_JUDGE_MAX_TOKENS ?? 0);
    const judgeMaxTokens = envCap > 0 ? envCap : (judgeProvider === "lmstudio" ? 768 : 96);
    const rf = (judgeProvider === "lmstudio" || judgeProvider === "poe") ? JUDGE_RESPONSE_SCHEMA : undefined;
    const raw = await askLLM(fullPrompt, judgeProvider, judgeMaxTokens, judgeModelOverride ?? undefined, rf);
    // JSON path (preferred, Poe/gpt-4o).
    const m = raw.match(/\{[\s\S]*?\}/);
    if (m) {
      try {
        const obj = JSON.parse(m[0]);
        if (typeof obj.correct === "boolean") return obj.correct ? 1 : 0;
      } catch { /* fall through */ }
    }
    // Text fallback — Gemini-flash prose + CORRECT/WRONG.
    const upper = raw.toUpperCase();
    if (/\bINCORRECT\b|\bWRONG\b|"CORRECT":\s*FALSE/.test(upper)) return 0;
    if (/\bCORRECT\b|"CORRECT":\s*TRUE/.test(upper)) return 1;
    process.stderr.write(`[judge] unparseable: ${raw.slice(0, 120)}\n`);
    return null;
  } catch (err) {
    process.stderr.write(`[judge] failed: ${err instanceof Error ? err.message : err}\n`);
    return null;
  }
}

async function askGemini(prompt: string, apiKey: string): Promise<string> {
  const cacheKey = { model: LLM_CONFIG.gemini.model, temperature: 0, seed: LLM_SEED, max_tokens: 256, prompt };
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
  const cacheKey = { model: LLM_CONFIG.minimax.model, temperature: 0.01, seed: LLM_SEED, max_tokens: 512, prompt };
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

/**
 * Extract the FINAL ANSWER section from a v14 CoT response.
 * The 7-step scaffold embeds gold tokens verbatim in STEP 2 / STEP 6, so F1/EM
 * on the raw response is ~100% regardless of correctness. Strip everything
 * except the text after "## FINAL ANSWER:". Fallback: last non-empty paragraph.
 */
function extractFinalAnswer(raw: string): string {
  if (!raw) return "";
  const s = raw.replace(/\r\n/g, "\n");
  const m = s.match(/(?:^|\n)\s*#{0,3}\s*FINAL ANSWER:?\s*\n?([\s\S]*?)\s*$/i);
  if (m && m[1]) return m[1].trim().replace(/^\[|\]$/g, "").trim();
  const paras = s.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
  return (paras[paras.length - 1] || s).trim();
}

/**
 * Persist {question_id, prompt, raw, extracted, model, provider, hash} to
 * disk so a later judge pass can rescore without regenerating answers.
 * Best-effort — swallow fs errors to keep the eval loop resilient.
 */
async function persistAnswer(
  questionId: string,
  question: string,
  prompt: string,
  raw: string,
  extracted: string,
  provider: LLMProvider,
): Promise<void> {
  if (process.env.LOTL_ANSWER_CACHE === "off") return;
  const model = LLM_CONFIG[provider].model;
  const hash = createHash("sha256")
    .update(`${questionId}\u0001${model}\u0001${provider}\u0001${prompt}`)
    .digest("hex").slice(0, 16);
  const dir = pathResolve(process.env.LOTL_ANSWER_CACHE_DIR || "evaluate/locomo/answer-cache");
  const path = `${dir}/${provider}-${hash}.json`;
  const payload = {
    question_id: questionId,
    question,
    model,
    provider,
    prompt_rules: process.env.LOTL_PROMPT_RULES || "v11",
    prompt_hash: createHash("sha256").update(prompt).digest("hex").slice(0, 16),
    raw,
    extracted,
    ts: new Date().toISOString(),
  };
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(payload, null, 2));
}

function buildAnswerPrompt(question: string, memories: string[], category: number, groundTruthIsNull: boolean = false): string {
  const context = memories.map((m, i) => `[${i + 1}] ${m}`).join("\n");
  const contextBlock = context;
  const promptVer = process.env.LOTL_PROMPT_RULES || "v11";

  // v14: 7-step CoT — ported verbatim from dial481/locomo-audit's answer_prompt_cot.
  // Audit showed this prompt alone (no memory system, just full context) lifts
  // GPT-4.1-mini from 81.95% (memos 5-6 word limit) to 92.62% on LoCoMo. The
  // expected output is ~2000 completion tokens; the FINAL ANSWER tag is
  // required for extractFinalAnswer() to strip the scaffold. Adversarial
  // (cat 5 / null gold) answers must still return "undefined" via the
  // instruction appended below.
  if (promptVer === "v14") {
    const abstentionRule = (category === 5 || groundTruthIsNull)
      ? "\n\nIMPORTANT: If the memories do not contain information to answer this question, FINAL ANSWER must be exactly: undefined"
      : "";
    return `You are an intelligent memory assistant tasked with retrieving accurate information from episodic memories.

# CONTEXT:
You have access to episodic memories from conversations between two speakers. These memories contain
timestamped information that may be relevant to answering the question.

# INSTRUCTIONS:
Your goal is to synthesize information from all relevant memories to provide a comprehensive and accurate answer.
You MUST follow a structured Chain-of-Thought process to ensure no details are missed.
Actively look for connections between people, places, and events to build a complete picture. Synthesize information from different memories to answer the user's question.
It is CRITICAL that you move beyond simple fact extraction and perform logical inference. When the evidence strongly suggests a connection, you must state that connection. Do not dismiss reasonable inferences as "speculation." Your task is to provide the most complete answer supported by the available evidence.

# CRITICAL REQUIREMENTS:
1. NEVER omit specific names - use "Amy's colleague Rob" not "a colleague"
2. ALWAYS include exact numbers, amounts, prices, percentages, dates, times
3. PRESERVE frequencies exactly - "every Tuesday and Thursday" not "twice a week"
4. MAINTAIN all proper nouns and entities as they appear${abstentionRule}

# RESPONSE FORMAT (You MUST follow this structure):

## STEP 1: RELEVANT MEMORIES EXTRACTION
[List each memory that relates to the question, with its timestamp]
- Memory 1: [timestamp] - [content]
- Memory 2: [timestamp] - [content]
...

## STEP 2: KEY INFORMATION IDENTIFICATION
[Extract ALL specific details from the memories]
- Names mentioned: [list all person names, place names, company names]
- Numbers/Quantities: [list all amounts, prices, percentages]
- Dates/Times: [list all temporal information]
- Frequencies: [list any recurring patterns]
- Other entities: [list brands, products, etc.]

## STEP 3: CROSS-MEMORY LINKING
[Identify entities that appear in multiple memories and link related information. Make reasonable inferences when entities are strongly connected.]
- Shared entities: [list people, places, events mentioned across different memories]
- Connections found: [e.g., "Memory 1 mentions A moved from hometown → Memory 2 mentions A's hometown is LA → Therefore A moved from LA"]
- Inferred facts: [list any facts that require combining information from multiple memories]

## STEP 4: TIME REFERENCE CALCULATION
[If applicable, convert relative time references]
- Original reference: [e.g., "last year" from May 2022]
- Calculated actual time: [e.g., "2021"]

## STEP 5: CONTRADICTION CHECK
[If multiple memories contain different information]
- Conflicting information: [describe]
- Resolution: [explain which is most recent/reliable]

## STEP 6: DETAIL VERIFICATION CHECKLIST
- [ ] All person names included: [list them]
- [ ] All locations included: [list them]
- [ ] All numbers exact: [list them]
- [ ] All frequencies specific: [list them]
- [ ] All dates/times precise: [list them]
- [ ] All proper nouns preserved: [list them]

## STEP 7: ANSWER FORMULATION
[Explain how you're combining the information to answer the question]

## FINAL ANSWER:
[Provide the concise answer with ALL specific details preserved]

---

Memories:
${contextBlock}

Question: ${question}

Now, follow the Chain-of-Thought process above to answer the question:`;
  }

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
 * Substring-Hit — lenient answer-quality check that catches F1's blind
 * spot on short numeric / name answers. "27" ⊂ "27 years old" → 1.
 */
function computeSubstringHit(prediction: string, groundTruth: string): number {
  const p = tokenize(prediction).join(" ");
  const t = tokenize(groundTruth).join(" ");
  if (t.length === 0) return 1;
  if (p.length === 0) return 0;
  return p.includes(t) ? 1 : 0;
}

/**
 * MRR — Mean Reciprocal Rank over the top-K memories, using the same
 * token-overlap relevance definition as R@K. Finds the first memory
 * that covers ≥50% of the ground-truth tokens and returns 1/rank.
 */
function computeMRR(memories: { text: string }[], groundTruth: string, k: number): number {
  const truthTokens = tokenize(groundTruth);
  if (truthTokens.length === 0) return 1;
  const topK = memories.slice(0, k);
  for (let i = 0; i < topK.length; i++) {
    const memTokens = new Set(tokenize(topK[i]!.text));
    const hits = truthTokens.filter(t => memTokens.has(t)).length;
    if (hits / truthTokens.length >= 0.5) return 1 / (i + 1);
  }
  return 0;
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
    if (args[i] === "--judge" && args[i + 1]) { judgeProvider = args[i + 1] as LLMProvider; }
    if (args[i] === "--judge-model" && args[i + 1]) { judgeModelOverride = args[i + 1]!; }
    if (args[i] === "--db-suffix" && args[i + 1]) dbSuffix = "-" + args[i + 1];
    if (args[i] === "--tag" && args[i + 1]) resultsTag = args[i + 1]!;
    // cat D: override LLM model for A-B testing — sets BOTH extract and answer model
    if (args[i] === "--model" && args[i + 1]) {
      const m = args[i + 1]!;
      LLM_CONFIG.gemini.model = m;
      LLM_CONFIG.gemini.url = `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`;
      process.env.LOTL_QUERY_EXPANSION_MODEL = m;
    }
    // Split: only override the answer model (keeps extract model on default/lite)
    if (args[i] === "--answer-model" && args[i + 1]) {
      const m = args[i + 1]!;
      LLM_CONFIG.gemini.model = m;
      LLM_CONFIG.gemini.url = `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`;
    }
    // --extract-model was pointing at LOTL_QUERY_EXPANSION_MODEL (wrong variable —
    // the extractor ignores it, and queryExpansion then 404s). Removed pending a
    // real per-call override in src/memory/extractor.ts.
  }

  // Ablation toggles via env vars (read once for logging)
  const ablation = {
    INGEST_SYNTHESIS: process.env.LOTL_INGEST_SYNTHESIS !== "off",
    INGEST_REFLECTIONS: process.env.LOTL_INGEST_REFLECTIONS !== "off",
    PROMPT_RULES: process.env.LOTL_PROMPT_RULES || "v11",
    RECALL_MMR: process.env.LOTL_RECALL_MMR === "on",
    RECALL_MMR_LAMBDA: parseFloat(process.env.LOTL_RECALL_MMR_LAMBDA || "0.85"),
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
  const dataPath = join(LOTL_DIR, "evaluate/locomo/locomo10.json");
  const data: Conversation[] = JSON.parse(readFileSync(dataPath, "utf-8"));
  const totalQA = data.reduce((n, c) => n + c.qa.length, 0);
  console.log(`\n  Dataset: ${data.length} conversations, ${totalQA} QA pairs`);
  console.log(`  Mode: ${ingestOnly ? "ingest only (build DB)" : useLLM ? `Lotl recall + ${LLM_CONFIG[activeLLM].model} answer` : "Lotl recall only (no LLM)"}`);
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
    sh: number;   // substring-hit (catches F1 short-answer blind spot)
    r5: number;
    r10: number;
    mrr: number;  // mean reciprocal rank over top-10 token-overlap hits
    sr5: number;
    sr10: number;
    sr15: number;
    sr50: number;
    dr5: number;   // dialog-level fractional recall (MemPalace compute_retrieval_recall)
    dr10: number;
    dr15: number;
    dr50: number;
    judge: number | null;  // LLM-as-judge verdict (1=CORRECT, 0=WRONG, null if disabled/errored)
    category: number;
    categoryName: string;
    searchMs: number;
    answerMs: number;
  }> = [];

  // Hoisted output path so per-question loop can incrementally persist
  // partial results. Final write at end of main() rewrites with full summary.
  // Atomic via writeFileSync(tmp) + renameSync — safe against kill mid-write.
  const resultsName = resultsTag ? `results-${resultsTag}.json` : "results.json";
  const outPath = join(LOTL_DIR, "evaluate/locomo", resultsName);
  const PARTIAL_SAVE_EVERY = parseInt(process.env.LOTL_EVAL_PARTIAL_EVERY || "10", 10);
  const totalQuestions = conversations.reduce((s, c: any) => s + (c.qa?.length || 0), 0);

  function savePartial() {
    const partial = {
      partial: true,
      progress: { completed: allResults.length, total: totalQuestions },
      results: allResults,
    };
    try {
      writeFileSync(outPath + ".tmp", JSON.stringify(partial));
      renameSync(outPath + ".tmp", outPath);
    } catch (e) {
      process.stderr.write(`\n[partial-save] failed: ${e}\n`);
    }
  }

  // Helper: ingest all sessions for a conversation
  async function ingestConversation(db: Database, c: Record<string, any>, scope: string) {
    let sessionCount = 0;
    let memoryCount = 0;
    const ingestStart = Date.now();

    // Storage mode toggles (cheap optimization knobs)
    const storeTurns = process.env.LOTL_INGEST_PER_TURN !== "off";
    const storeSessions = process.env.LOTL_INGEST_SESSION_AS_MEMORY !== "off";
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
      if (process.env.LOTL_INGEST_EXTRACTION !== "off") {
        try {
          const eResult = await extractAndStore(db, sessionLines.join("\n"), scope);
          memoryCount += eResult.stored;
        } catch { /* extraction optional */ }
      }

      // v13: extract reflections (cat 18) — toggleable via LOTL_INGEST_REFLECTIONS=off
      if (process.env.LOTL_INGEST_REFLECTIONS !== "off") {
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

    // v13: Per-entity synthesis from KG (cat 11) — toggleable via LOTL_INGEST_SYNTHESIS=off
    if (process.env.LOTL_INGEST_SYNTHESIS !== "off") {
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
    const dbDir = join(LOTL_DIR, "evaluate/locomo/dbs");
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
    let runningJudgeCorrect = 0;
    let runningJudgeN = 0;

    // Worker-pool semaphore: N concurrent question-processors pulling from a
    // shared index queue. LOTL_LOCOMO_WORKERS=1 preserves the original
    // sequential behavior. Safe because JS async is single-threaded — state
    // mutations (runningF1 += f1, allResults.push) are atomic between awaits.
    // Under concurrency the progress-line denominator switches to a
    // `completed` counter since i is no longer in completion order.
    const locomoConcurrency = Math.max(1, parseInt(process.env.LOTL_LOCOMO_WORKERS || "1", 10));
    if (locomoConcurrency > 1) console.log(`    Workers: ${locomoConcurrency} concurrent`);
    let completed = 0;
    const indexQueue = Array.from({ length: qaList.length }, (_, i) => i);
    const processQuestion = async (i: number): Promise<void> => {
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
      // LOTL_RECALL_REFLECT=on. Adds one extra LLM call per question.
      //
      // v16.1 fix: AUGMENT the memory list with the reflection block at
      // the top — don't REPLACE it. v16-full shipped replacement and lost
      // ~20pp F1 on LME because the compressed bullets dropped exact
      // wording the answer model needed for date arithmetic and ordering.
      // Honest-eval: cap LLM-context memories to top-10 (Mem0-paper default, matches Lotl's
      // LongMemEval eval). LoCoMo convs have up to 32 sessions — top-50 LLM context would
      // leak the full conversation regardless of ranking quality (MemPalace's admitted cheat).
      // Retrieval metrics (R@5 / R@10 / MRR) still slice from the full 50-pool above.
      // Override via LOTL_LOCOMO_ANSWER_TOP_K for ablation.
      const LOCOMO_ANSWER_TOP_K = Number(process.env.LOTL_LOCOMO_ANSWER_TOP_K ?? 10);
      let answerMemories = memories.slice(0, LOCOMO_ANSWER_TOP_K).map(m => m.text);
      if (process.env.LOTL_RECALL_REFLECT === "on" && memories.length > 0 && useLLM) {
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
          // v14 CoT emits ~1500–2500 output tokens (7-step scaffold + final answer).
          // Other prompt versions stay at the default (256) because they explicitly
          // instruct "Short answer:" — no reason to pay for longer output.
          // LOTL_ANSWER_MAX_TOKENS is a FLOOR — bumps v11 up for local thinking models
          // (gemma-4-e4b burns 100+ reasoning tokens before emitting content) without
          // capping v14's CoT budget below its need.
          const defaultMax = process.env.LOTL_PROMPT_RULES === "v14" ? 2560 : 256;
          const envFloor = Number(process.env.LOTL_ANSWER_MAX_TOKENS ?? 0);
          const answerMaxTokens = Math.max(envFloor, defaultMax);
          const raw = await askLLM(prompt, activeLLM, answerMaxTokens);
          // For v14 strip the CoT scaffold and keep only the FINAL ANSWER.
          // Scoring the raw scaffold is ~100% F1 because STEP 2 / STEP 6 echo
          // the gold tokens verbatim.
          const extracted = process.env.LOTL_PROMPT_RULES === "v14" ? extractFinalAnswer(raw) : raw;
          prediction = extracted;
          // Persist {question, prompt, raw, extracted, model, hash} for replay
          // with a different judge without regenerating answers.
          try { await persistAnswer(`${conv.sample_id}-q${i}`, qa.question, prompt, raw, extracted, activeLLM); } catch { /* best-effort */ }
        } catch (e) {
          prediction = memories.map(m => m.text).join(" "); // fallback to raw memories
          process.stderr.write(`\n    [warn] LLM failed for q${i}: ${e}\n`);
        }
        answerMs = Date.now() - t1;
      } else {
        prediction = memories.map(m => m.text).join(" ");
      }

      // Normalize answer: LoCoMo adversarial questions have answer=undefined (missing field)
      const answer = qa.answer != null ? String(qa.answer) : "undefined";
      const f1 = computeF1(prediction, answer);
      const em = computeExactMatch(prediction, answer);
      const sh = computeSubstringHit(prediction, answer);
      const r5 = computeRecallAtK(memories, answer, 5);
      const r10 = computeRecallAtK(memories, answer, 10);
      const mrr = computeMRR(memories, answer, 10);
      // Session-level any-match (MemPalace-compat, coarse — kept for reference)
      const evidenceIds = (qa as any).evidence as string[] | undefined;
      const sr5 = computeSessionRecallAtK(memories, evidenceIds, 5);
      const sr10 = computeSessionRecallAtK(memories, evidenceIds, 10);
      const sr15 = computeSessionRecallAtK(memories, evidenceIds, 15);
      const sr50 = computeSessionRecallAtK(memories, evidenceIds, 50);
      // Dialog-level fractional recall (MemPalace compute_retrieval_recall)
      const dr5 = computeDialogRecallAtK(memories, evidenceIds, 5);
      const dr10 = computeDialogRecallAtK(memories, evidenceIds, 10);
      const dr15 = computeDialogRecallAtK(memories, evidenceIds, 15);
      const dr50 = computeDialogRecallAtK(memories, evidenceIds, 50);
      runningF1 += f1;
      runningEM += em;
      // LLM-as-judge (Mem0-style CORRECT/WRONG) — only when --judge is set.
      // Tracks a separate running sum + count since judge calls may fail mid-run.
      const judgeVerdict = (judgeProvider && useLLM && prediction)
        ? await askJudge(qa.question, prediction, answer)
        : null;
      if (judgeVerdict != null) {
        runningJudgeCorrect += judgeVerdict;
        runningJudgeN += 1;
      }

      allResults.push({
        sample_id: conv.sample_id,
        question: qa.question,
        answer,
        prediction: prediction.slice(0, 300),
        memories: memories.map(m => m.text.slice(0, 120)),
        memoriesFound: memories.length,
        f1, em, sh, r5, r10, mrr, sr5, sr10, sr15, sr50, dr5, dr10, dr15, dr50,
        judge: judgeVerdict,
        category: qa.category,
        categoryName: CATEGORY_NAMES[qa.category] || "unknown",
        searchMs, answerMs,
      });

      if (allResults.length % PARTIAL_SAVE_EVERY === 0) savePartial();

      // Progress: use `completed` counter so workers finishing out-of-order
      // still advance the bar monotonically. avgF1 denominator follows.
      completed++;
      const avgF1 = runningF1 / completed;
      const line = [
        `\r    ${progressBar(completed, qaList.length)}`,
        `F1=${(avgF1 * 100).toFixed(1)}%`,
        `mem=${memories.length}`,
        `search=${searchMs}ms`,
        useLLM ? `llm=${answerMs}ms` : "",
        elapsed(evalStart),
      ].filter(Boolean).join(" | ");
      process.stdout.write(line);

      // Detailed output every 10 or on last
      if (completed % 10 === 0 || completed === qaList.length) {
        console.log(); // newline after progress bar
      }
    };

    // Run the worker pool. Each worker pulls indices from the shared queue.
    const locomoWorker = async () => {
      while (indexQueue.length > 0) {
        const idx = indexQueue.shift();
        if (idx == null) break;
        try { await processQuestion(idx); }
        catch (e) { process.stderr.write(`\n    [error] q${idx}: ${e}\n`); }
      }
    };
    await Promise.all(Array.from({ length: locomoConcurrency }, () => locomoWorker()));

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
  const avgSH = allResults.reduce((s, r) => s + r.sh, 0) / n;
  const avgMRR = allResults.reduce((s, r) => s + r.mrr, 0) / n;
  const avgSearch = allResults.reduce((s, r) => s + r.searchMs, 0) / n;
  const avgAnswer = allResults.reduce((s, r) => s + r.answerMs, 0) / n;
  const avgMemories = allResults.reduce((s, r) => s + r.memoriesFound, 0) / n;

  console.log(`\n${"=".repeat(64)}`);
  console.log(`  FINAL RESULTS  (n=${n})`);
  console.log(`${"=".repeat(64)}`);
  console.log(`  Retrieval (primary):`);
  console.log(`    R@5:    ${(avgR5 * 100).toFixed(1)}%   (single-pass)`);
  console.log(`    R@10:   ${(avgR10 * 100).toFixed(1)}%   (multi-pass)`);
  console.log(`    MRR:    ${avgMRR.toFixed(3)}    (rank quality, 1/rank of first hit)`);
  console.log(`  Answer quality (primary):`);
  console.log(`    F1:     ${(avgF1 * 100).toFixed(1)}%   (token overlap, fuzzy)`);
  console.log(`    EM:     ${(avgEM * 100).toFixed(1)}%   (exact match, strict)`);
  console.log(`    SH:     ${(avgSH * 100).toFixed(1)}%   (substring hit — catches short-answer EM false negatives)`);
  // LLM-as-judge — only printed when --judge was set (Mem0-style CORRECT/WRONG semantic grading).
  const judgeSamples = allResults.filter(r => r.judge != null);
  if (judgeSamples.length > 0) {
    const judgeN = judgeSamples.length;
    const judgeCorrect = judgeSamples.reduce((s, r) => s + (r.judge ?? 0), 0);
    console.log(`    Judge:  ${(judgeCorrect / judgeN * 100).toFixed(1)}%   (LLM-as-judge binary, n=${judgeN} via ${judgeProvider}${judgeModelOverride ? "/" + judgeModelOverride : ""})`);
  }
  console.log(`  MemPalace-compat (reference only, take with salt — SR ceilings easily, DR depends on ground-truth quality):`);
  console.log(`    DR@5 / DR@10 / DR@15 / DR@50 = ${(avgDR5 * 100).toFixed(1)}% / ${(avgDR10 * 100).toFixed(1)}% / ${(avgDR15 * 100).toFixed(1)}% / ${(avgDR50 * 100).toFixed(1)}%`);
  console.log(`    SR@5 / SR@10 / SR@15 / SR@50 = ${(avgSR5 * 100).toFixed(1)}% / ${(avgSR10 * 100).toFixed(1)}% / ${(avgSR15 * 100).toFixed(1)}% / ${(avgSR50 * 100).toFixed(1)}%`);
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
    const csh = cr.reduce((s, r) => s + r.sh, 0) / cr.length;
    console.log(`    ${(CATEGORY_NAMES[cat] || String(cat)).padEnd(12)} (n=${String(cr.length).padStart(4)}): R@5=${(cr5 * 100).toFixed(0).padStart(3)}%  R@10=${(cr10 * 100).toFixed(0).padStart(3)}%  F1=${(cf1 * 100).toFixed(1).padStart(5)}%  EM=${(cem * 100).toFixed(1).padStart(5)}%  SH=${(csh * 100).toFixed(1).padStart(5)}%`);
  }

  if (conversations.length > 1) {
    console.log(`\n  By conversation:`);
    for (const cid of [...new Set(allResults.map(r => r.sample_id))]) {
      const cr = allResults.filter(r => r.sample_id === cid);
      const cf1 = cr.reduce((s, r) => s + r.f1, 0) / cr.length;
      const cr5 = cr.reduce((s, r) => s + r.r5, 0) / cr.length;
      const cr10 = cr.reduce((s, r) => s + r.r10, 0) / cr.length;
      console.log(`    ${cid} (n=${cr.length}): R@5=${(cr5 * 100).toFixed(1)}% R@10=${(cr10 * 100).toFixed(1)}% F1=${(cf1 * 100).toFixed(1)}%`);
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

  // Final save — outPath already declared above for incremental partial saves.
  // This rewrites the file with the full summary block (no `partial: true`).
  writeFileSync(outPath, JSON.stringify({
    config: { useLLM, model: useLLM ? LLM_CONFIG[activeLLM].model : "none", llm: activeLLM, limit, convFilter },
    summary: {
      // Primary metrics (lead with these)
      avgR5, avgR10, avgMRR, avgF1, avgEM, avgSH,
      // MemPalace-compat reference (demoted — take with a grain of salt)
      avgDR5, avgDR10, avgDR15, avgDR50,
      avgSR5, avgSR10, avgSR15, avgSR50,
      // Timing
      avgSearch, avgAnswer, avgMemories, total: n,
    },
    results: allResults,
  }, null, 2));
  console.log(`\n  Results saved: ${outPath}`);
}

main().catch(e => { console.error(e); process.exit(1); });
