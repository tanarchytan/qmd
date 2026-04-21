/**
 * LongMemEval evaluation: Lotl memory pipeline against the LongMemEval benchmark.
 *
 * Dataset: https://github.com/xiaowu0162/longmemeval (ICLR 2025)
 *   - longmemeval_oracle.json — only relevant sessions (~1.9 per question, fast)
 *   - longmemeval_s.json     — ~47 sessions per question (full retrieval)
 *
 * Usage:
 *   npx tsx evaluate/longmemeval/eval.mts --ds oracle --limit 50 --llm gemini
 *   npx tsx evaluate/longmemeval/eval.mts --ds s --limit 100 --llm gemini
 *
 * Env: same env-var toggles as locomo eval (LOTL_INGEST_REFLECTIONS, LOTL_RECALL_MMR, etc.)
 */

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from "fs";
import { join, dirname, resolve as pathResolve } from "path";
import { pathToFileURL } from "url";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { openCache } from "../../src/llm/cache.js";
import { applyEvalEnvCompat } from "../shared/env-compat.js";

// Phase E (#47) — mirror LOTL_EVAL_* ↔ LOTL_* for eval-only vars so existing
// scripts (phase-b-gemma.sh, sweep-flags.sh) keep working while new docs +
// scripts migrate to the LOTL_EVAL_* namespace. MUST run before env reads.
applyEvalEnvCompat();

// Default LOTL_RECALL_NO_TOUCH=on for the whole eval module. This MUST be set
// before src/memory/index.ts is imported (below) so the first recall also
// sees it. Without this, memoryRecall bumps access_count each call which
// shifts Weibull-decay ranking → changes retrieved memories → changes the
// prompt → invalidates llm-cache keys → re-runs cache-miss and try to
// regenerate. Caught 2026-04-19, cost 3+ LM Studio crashes. Scripts already
// export this but setting it here is belt+suspenders for new scripts.
// Explicit opt-out (production behavior): LOTL_RECALL_NO_TOUCH=off.
if (process.env.LOTL_RECALL_NO_TOUCH === undefined) process.env.LOTL_RECALL_NO_TOUCH = "on";

// Cache path is overridable — lets alternative model stacks (gemma, etc.)
// keep their own cache without polluting the canonical llama/qwen cache.
const LLM_CACHE_PATH = process.env.LOTL_LLM_CACHE_PATH || join(process.cwd(), "evaluate/longmemeval/llm-cache.json");
const llmCache = openCache(LLM_CACHE_PATH);
process.env.LOTL_LLM_CACHE_PATH = LLM_CACHE_PATH;

const LOTL_DIR = process.cwd();
function toUrl(p: string) { return pathToFileURL(p).href; }

const { loadQmdEnv } = await import(toUrl(join(LOTL_DIR, "src/env.ts")));
loadQmdEnv();

const { openDatabase } = await import(toUrl(join(LOTL_DIR, "src/db.ts")));
const { initializeDatabase } = await import(toUrl(join(LOTL_DIR, "src/store/db-init.ts")));
const { memoryStore, memoryStoreBatch, memoryRecall, extractAndStore, consolidateEntityFacts, memoryReflect, turnsToText } = await import(toUrl(join(LOTL_DIR, "src/memory/index.ts")));

type Database = ReturnType<typeof openDatabase>;

// ---------------------------------------------------------------------------
// LLM
// ---------------------------------------------------------------------------

type LLMProvider = "gemini" | "minimax" | "poe" | "lmstudio";
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
  // Poe OpenAI-compatible endpoint — one key, access to gpt-4o / claude / gemini / etc.
  // Model override via LOTL_POE_MODEL (default gpt-4o). Requires active Poe subscription.
  poe: {
    url: "https://api.poe.com/v1/chat/completions",
    model: process.env.LOTL_POE_MODEL || "gpt-4o",
    keyEnv: "POE_API_KEY",
  },
  // LM Studio (local, OpenAI-compatible) — no real API key needed, send placeholder.
  // Host+port via LOTL_LMSTUDIO_HOST (default 10.0.0.105:1234). Models via
  // LOTL_LMSTUDIO_GEN_MODEL (default meta-llama-3.1-8b-instruct) +
  // LOTL_LMSTUDIO_JUDGE_MODEL (default qwen/qwen3.6-35b-a3b). Model swap
  // handled explicitly via loadLmStudioModel/unloadLmStudioModel.
  lmstudio: {
    url: `http://${process.env.LOTL_LMSTUDIO_HOST || "10.0.0.105:1234"}/v1/chat/completions`,
    model: process.env.LOTL_LMSTUDIO_GEN_MODEL || "meta-llama-3.1-8b-instruct",
    keyEnv: "LOTL_LMSTUDIO_KEY",
  },
};
const LLM_SEED = 42;
let activeLLM: LLMProvider = "gemini";
// Optional judge provider (--judge flag). Runs after prediction to produce a
// correctness verdict via LLM-as-judge, independent of the generator LLM.
let judgeProvider: LLMProvider | null = null;
// Per-call model override for the judge. Lets `--llm poe --judge poe` use a cheap
// model for generation and a strong model for grading in the same Poe account.
let judgeModelOverride: string | null = null;

// Build a Gemini URL for arbitrary model name (used by --extract-model split)
function geminiUrl(model: string): string {
  return `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
}

async function askGemini(prompt: string, apiKey: string): Promise<string> {
  // askGemini hardcodes maxOutputTokens=256 below; reflect in the cache key
  // so it stays consistent with the max_tokens-keyed OpenAI-compat path.
  const cacheKey = { model: LLM_CONFIG.gemini.model, temperature: 0, seed: LLM_SEED, max_tokens: 256, prompt };
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

/** OpenAI-compatible chat/completions. Shared by Poe + any other
 *  OpenAI-shape provider we add later. Cache-aware via llmCache. */
// Accumulated usage across every LLM call in this run. Persisted into the
// results JSON so we can trace cost/quality tradeoffs per experiment.
const usageTotals = {
  input: 0,
  output: 0,
  callsGen: 0,
  callsJudge: 0,
};

async function askOpenAICompat(
  prompt: string,
  apiKey: string,
  url: string,
  model: string,
  maxTokens: number = 256,
  callType: "gen" | "judge" = "gen",
  responseFormat?: Record<string, unknown>,
  seedOverride?: number,
): Promise<string> {
  // Seed override lets the 3-run judge majority vote call the same prompt N
  // times at different seeds and collect independent verdicts. Passed into
  // both the cache key and the request body.
  const effectiveSeed = seedOverride ?? LLM_SEED;
  // Include maxTokens in the cache key. Thinking models like qwen/gemma can
  // burn the whole budget on reasoning_content before emitting content — a
  // prior call with too-small maxTokens caches an empty content string, and
  // subsequent calls with a larger maxTokens would cache-hit that garbage
  // without this field in the key (caught 2026-04-19 with gemma-4-e4b v11).
  const cacheKey = { model, temperature: 0, seed: effectiveSeed, max_tokens: maxTokens, prompt };
  const cached = llmCache.get(cacheKey);
  if (cached != null) return cached;
  const body: Record<string, unknown> = {
    model,
    messages: [{ role: "user", content: prompt }],
    temperature: 0,
    // Pass seed so Poe/OpenAI can return deterministic outputs at temp=0 —
    // identical inputs produce identical outputs → cache hits on re-run.
    seed: effectiveSeed,
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
  // Capture per-call token usage when provided (Poe/OpenAI return `usage`).
  const u = data.usage;
  if (u) {
    usageTotals.input += Number(u.prompt_tokens ?? 0);
    usageTotals.output += Number(u.completion_tokens ?? 0);
  }
  if (callType === "gen") usageTotals.callsGen++;
  else usageTotals.callsJudge++;
  let text = (data.choices?.[0]?.message?.content || "").replace(/^["']|["']$/g, "").trim();
  llmCache.set(cacheKey, text);
  return text;
}

/** Pre-flight quota probe. Hits the judge/gen provider with a 1-token ping so
 *  a low-quota account fails fast before ingesting 100+ questions. No-op if
 *  LOTL_SKIP_PREFLIGHT=on. */
async function preflightQuotaCheck(provider: LLMProvider, model: string): Promise<void> {
  if (process.env.LOTL_SKIP_PREFLIGHT === "on") return;
  const cfg = LLM_CONFIG[provider];
  const apiKey = process.env[cfg.keyEnv];
  if (!apiKey) throw new Error(`${cfg.keyEnv} not set — cannot preflight ${provider}`);
  try {
    if (provider === "poe") {
      const resp = await fetch(cfg.url, {
        method: "POST",
        headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: "ok" }],
          // Poe enforces max_tokens >= 16. Use the minimum — preflight
          // burns ~20-30 points per model probed, trivial cost to catch
          // quota errors before the main run.
          temperature: 0, seed: LLM_SEED, max_tokens: 16,
        }),
      });
      const body = await resp.text();
      if (!resp.ok) {
        throw new Error(`preflight ${provider}/${model} HTTP ${resp.status}: ${body.slice(0, 200)}`);
      }
    }
    // Gemini preflight: skip — free tier, no quota probe needed beyond key presence.
    process.stderr.write(`[preflight] ${provider}/${model} ok\n`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Preflight failed for ${provider}/${model}. Aborting run to avoid mid-eval blowup.\n  ${msg}`);
  }
}

async function askLLM(
  prompt: string,
  provider: LLMProvider = activeLLM,
  maxTokens: number = 128,
  modelOverride?: string,
  callType: "gen" | "judge" = "gen",
  responseFormat?: Record<string, unknown>,
  seedOverride?: number,
): Promise<string> {
  const cfg = LLM_CONFIG[provider];
  const apiKey = process.env[cfg.keyEnv];
  if (!apiKey) throw new Error(`${cfg.keyEnv} not set`);
  const model = modelOverride || cfg.model;
  if (provider === "gemini") {
    // Gemini URL path is model-specific — rebuild on override. Seed override
    // for Gemini isn't plumbed (single-seed path); 3-run majority vote falls
    // back to single-run for Gemini.
    if (modelOverride) {
      const url = geminiUrl(modelOverride) + `?key=${apiKey}`;
      return askGeminiDirect(prompt, url, modelOverride);
    }
    return askGemini(prompt, apiKey);
  }
  if (provider === "poe") return askOpenAICompat(prompt, apiKey, cfg.url, model, maxTokens, callType, responseFormat, seedOverride);
  if (provider === "lmstudio") return askOpenAICompat(prompt, apiKey || "lm-studio", cfg.url, model, maxTokens, callType, responseFormat, seedOverride);
  throw new Error(`LLM provider not supported: ${provider}`);
}

// JSON Schema for the judge verdict. LM Studio (llama.cpp backend) enforces
// strict JSON output server-side when passed in response_format — eliminates
// the 10-13% unparseable-verdict rate we saw with gemma-4-26b-a4b at n=500.
// OpenAI/Poe also accept this format (json_schema is the newer API vs the
// legacy json_object). Gemini doesn't support it so we skip there.
const JUDGE_RESPONSE_SCHEMA = {
  type: "json_schema",
  json_schema: {
    name: "verdict",
    strict: true,
    schema: {
      type: "object",
      properties: {
        correct: { type: "boolean" },
        reason: { type: "string" },
      },
      required: ["correct", "reason"],
      additionalProperties: false,
    },
  },
};

// -----------------------------------------------------------------------------
// LM Studio model-swap helpers
//
// LM Studio exposes /api/v1/models/{load,unload} to swap which model occupies
// VRAM. Used for two-pass eval: load gen model → generate all answers →
// unload → load judge model → judge all predictions. Keeps a 3090 viable
// even when gen + judge models together exceed VRAM.
// -----------------------------------------------------------------------------
async function lmStudioAdmin(action: "load" | "unload", model: string): Promise<void> {
  const host = process.env.LOTL_LMSTUDIO_HOST || "10.0.0.105:1234";
  const url = `http://${host}/api/v1/models/${action}`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model }),
  });
  const text = await resp.text();
  if (!resp.ok) throw new Error(`LM Studio ${action} ${model} HTTP ${resp.status}: ${text.slice(0, 200)}`);
  process.stderr.write(`[lmstudio] ${action} ${model} ok (${text.slice(0, 100)})\n`);
}
async function loadLmStudioModel(model: string): Promise<void> { return lmStudioAdmin("load", model); }
async function unloadLmStudioModel(model: string): Promise<void> { return lmStudioAdmin("unload", model); }

// -----------------------------------------------------------------------------
// v14 CoT final-answer extraction
//
// The 7-step Chain-of-Thought scaffold embeds the gold tokens verbatim in the
// STEP 2 / STEP 6 checklists, so F1/EM scored on the raw response is ~100%
// regardless of answer correctness. We strip the scaffold and keep only the
// text after "## FINAL ANSWER:" (or "FINAL ANSWER:" without markdown hashes).
// Fallback: if the model skipped the tag, return the last non-empty paragraph
// — better than scoring the whole dump.
// -----------------------------------------------------------------------------
function extractFinalAnswer(raw: string): string {
  if (!raw) return "";
  const s = raw.replace(/\r\n/g, "\n");
  // Primary: explicit tag with optional markdown hashes + any leading whitespace.
  const m = s.match(/(?:^|\n)\s*#{0,3}\s*FINAL ANSWER:?\s*\n?([\s\S]*?)\s*$/i);
  if (m && m[1]) return m[1].trim().replace(/^\[|\]$/g, "").trim();
  // Fallback: last non-empty paragraph.
  const paras = s.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
  return (paras[paras.length - 1] || s).trim();
}

// -----------------------------------------------------------------------------
// Answer persistence — disk-backed replay cache
//
// Writes one JSON per prediction to evaluate/longmemeval/answer-cache/<hash>.json
// so a later judge pass (different judge model, different leniency, Poe vs LM
// Studio qwen) can rescore without re-running generation. Keyed on sha256 of
// {question_id, prompt, model, provider} so prompt changes invalidate cleanly.
// Best-effort — any fs error is swallowed; eval flow is unaffected.
// -----------------------------------------------------------------------------
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
  const dir = pathResolve(process.env.LOTL_ANSWER_CACHE_DIR || "evaluate/longmemeval/answer-cache");
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

// Minimal Gemini caller that takes pre-built url — used when --judge-model overrides.
async function askGeminiDirect(prompt: string, url: string, model: string): Promise<string> {
  // Gemini uses maxOutputTokens=256 hardcoded — cache key reflects that for
  // consistency with the max_tokens-keyed Poe/LM Studio path.
  const cacheKey = { model, temperature: 0, seed: LLM_SEED, max_tokens: 256, prompt };
  const cached = llmCache.get(cacheKey);
  if (cached != null) return cached;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0, seed: LLM_SEED, maxOutputTokens: 256 },
    }),
  });
  if (!resp.ok) throw new Error(`${model} ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  const data = await resp.json() as any;
  let text = data.candidates?.[0]?.content?.parts
    ?.filter((p: any) => p.text && !p.thought)
    ?.map((p: any) => p.text).join("") || "";
  text = text.replace(/^["']|["']$/g, "").trim();
  llmCache.set(cacheKey, text);
  return text;
}

/** LLM-as-judge: returns 1 if the prediction correctly matches the gold answer, 0 otherwise.
 *  Prompt style mirrors LongMemEval paper's evaluate_qa.py — strict factual equivalence,
 *  not string match. Uses the provider set via --judge flag. */
const JUDGE_SYSTEM_PROMPT =
  "You are a strict but fair grader. Given a question, a gold-standard answer, and a candidate answer, decide whether the candidate answer is factually equivalent to the gold. " +
  "CORRECT if the candidate expresses the same facts as the gold (different wording or extra non-contradictory detail is fine). " +
  "INCORRECT if any required fact is missing, contradicted, or has a different value. " +
  "Respond on one line with a single JSON object: {\"correct\": true|false, \"reason\": \"<short sentence>\"}";

/**
 * Single judge call at a given seed. Internal helper; public entry is
 * askJudge which handles N-run majority vote (LOTL_JUDGE_RUNS).
 * Returns 1 (correct), 0 (wrong), or null (unparseable / fetch-fail).
 */
async function askJudgeOnce(fullPrompt: string, seed: number): Promise<number | null> {
  if (!judgeProvider) return null;
  try {
    const envCap = Number(process.env.LOTL_JUDGE_MAX_TOKENS ?? 0);
    const judgeMaxTokens = envCap > 0 ? envCap : (judgeProvider === "lmstudio" ? 768 : 96);
    const rf = (judgeProvider === "lmstudio" || judgeProvider === "poe") ? JUDGE_RESPONSE_SCHEMA : undefined;
    const raw = await askLLM(fullPrompt, judgeProvider, judgeMaxTokens, judgeModelOverride ?? undefined, "judge", rf, seed);
    const m = raw.match(/\{[\s\S]*?\}/);
    if (m) {
      try {
        const obj = JSON.parse(m[0]);
        if (typeof obj.correct === "boolean") return obj.correct ? 1 : 0;
      } catch { /* fall through */ }
    }
    const upper = raw.toUpperCase();
    if (/\bINCORRECT\b|\bWRONG\b|"CORRECT":\s*FALSE/.test(upper)) return 0;
    if (/\bCORRECT\b|"CORRECT":\s*TRUE/.test(upper)) return 1;
    process.stderr.write(`[judge] unparseable verdict (seed=${seed}): ${raw.slice(0, 120)}\n`);
    return null;
  } catch (err) {
    process.stderr.write(`[judge] failed (seed=${seed}): ${err instanceof Error ? err.message : err}\n`);
    return null;
  }
}

/**
 * LLM-as-judge with optional N-run majority vote. LOTL_JUDGE_RUNS=N (default 1).
 * N>1 runs the same judge prompt N times at seeds LLM_SEED, LLM_SEED+1, ... and
 * returns the majority vote (ties broken toward 0). Any individual run that
 * returns null still counts as a non-vote; requires > N/2 non-null agreeing
 * votes for a verdict. Audit methodology: EverMemOS / LongMemEval paper.
 */
async function askJudge(question: string, predicted: string, gold: string): Promise<number | null> {
  if (!judgeProvider) return null;
  const userMsg =
    `QUESTION: ${question.trim()}\n\n` +
    `GOLD ANSWER: ${gold.trim()}\n\n` +
    `CANDIDATE ANSWER: ${predicted.trim()}\n\n` +
    `Respond with the JSON object only.`;
  const fullPrompt = `${JUDGE_SYSTEM_PROMPT}\n\n${userMsg}`;
  const runs = Math.max(1, Number(process.env.LOTL_JUDGE_RUNS ?? 1));
  if (runs === 1) return askJudgeOnce(fullPrompt, LLM_SEED);
  // N-run: call with seeds LLM_SEED, LLM_SEED+1, LLM_SEED+2, ...
  const verdicts: (number | null)[] = [];
  for (let i = 0; i < runs; i++) verdicts.push(await askJudgeOnce(fullPrompt, LLM_SEED + i));
  const ones = verdicts.filter(v => v === 1).length;
  const zeros = verdicts.filter(v => v === 0).length;
  // Majority vote; ties → 0 (strict default). Unanimous-null → null.
  if (ones === 0 && zeros === 0) return null;
  return ones > zeros ? 1 : 0;
}

function buildAnswerPrompt(question: string, memories: string[], questionType: string): string {
  const context = memories.map((m, i) => `[${i + 1}] ${m}`).join("\n");
  const isAbstention = questionType.endsWith("_abs");
  const rules = process.env.LOTL_PROMPT_RULES || "v11";

  // v14: 7-step Chain-of-Thought prompt, ported verbatim from the locomo-audit
  // repo's `answer_prompt_cot` (evaluation/config/prompts.yaml). Mandated structure
  // forces the generator through extraction → key info → cross-memory linking →
  // time resolution → contradiction check → detail verification → formulation.
  // Final answer is tagged with "## FINAL ANSWER:" and extracted by
  // extractFinalAnswer() before scoring/judging. Expected to cost ~2000 output
  // tokens per question but the audit shows it lifts full-context QA from 81.9%
  // (memos 5-6 word limit) to 92.6% on GPT-4.1-mini. No word limit here on
  // purpose — the audit found word-limit prompts confound memory-vs-prompt gap.
  if (rules === "v14") {
    const abstentionRule = isAbstention
      ? "\n\nIMPORTANT: If the memories do not contain enough information to answer, FINAL ANSWER must be exactly: I don't know."
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
${context}

Question: ${question}

Now, follow the Chain-of-Thought process above to answer the question:`;
  }

  // v13: minimal prompt matching LongMemEval paper / Mem0 / RAGAS best practice.
  // No rule list, no CoT scaffolding — just memories + question.
  // Recommended for `--judge` runs (rule lists constrain phrasing and hurt LLM-judge).
  if (rules === "v13") {
    const preamble = isAbstention
      ? "Answer the question based on the memories below. If the memories do not contain the information needed, respond with exactly: I don't know."
      : "Answer the question based on the memories below.";
    return `You are a helpful assistant answering questions about a user based on their conversation history.

Memories:
${context}

${preamble}

Question: ${question}
Answer:`;
  }

  if (isAbstention) {
    return `${context}

Based on the above context, answer the following question.
If the context does NOT contain information to answer this question, respond with exactly: I don't know.

Question: ${question} Short answer:`;
  }

  // v11 (default): tuned for F1/EM string-overlap scoring.
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

// =============================================================================
// METRIC SPACE — distinct families, each with a clear audience
// =============================================================================
// See devnotes/metrics/metric-discipline.md for the walkthrough. Naming trap: different
// memory-benchmark publications use the same labels for different metrics.
// We compute and display them separately so nothing is ambiguous.
//
// SESSION-ID RETRIEVAL (the one you compare against other memory systems)
//
//   recall_any@K    — BINARY: 1 if ANY gold session is in top-K, 0 else.
//                     Used by: agentmemory, mem0, MemPalace (they all call
//                     this "R@K" in their published tables). Easy metric,
//                     especially on multi-session questions.
//                     Function: computeSessionRecallAnyAtK
//
//   R@K             — FRACTIONAL: |gold ∩ retrieved_top_k| / |gold|.
//                     Used by: LongMemEval paper. "What fraction of the
//                     evidence did you find?". Harder on multi-session:
//                     3 gold sessions, 2 in top-5 → 0.667, not 1.0.
//                     Function: computeSessionRecallAtK
//
//   MRR             — 1 / rank of FIRST gold session found in top-K.
//                     Blind to multi-session coverage — scores 1.0 if
//                     the first gold session is at rank 1, regardless of
//                     whether the other gold sessions are found.
//                     Function: computeSessionMRR
//
//   NDCG@K          — Discounted Cumulative Gain normalized per-question.
//                     Binary relevance (is session_id in gold?).
//                     IDCG uses min(K, |gold|) — critical for multi-session
//                     correctness. Deduplicates by session_id so multiple
//                     retrieved chunks from the same session count once.
//                     Function: computeSessionNDCG
//
// CONTENT COVERAGE (lotl-specific — NOT comparable with any competitor)
//
//   Cov@K / Cov-MRR / Cov-NDCG@K
//     Token-overlap based: does the retrieved memory's text actually
//     contain ≥50% of the answer tokens? Useful for understanding
//     downstream answer-quality within correctly-retrieved sessions.
//     A question can have recall_any@5 = 1.0 but Cov@5 = 0 if we get
//     the right session but not the right sub-chunk.
//     Functions: computeContentRecallAtK, computeContentMRR, computeContentNDCG
//
// ANSWER QUALITY (what published LeaderBoards report — NOT what we compute)
//
//   LongMemEval QA accuracy
//     LLM-as-judge flow: retrieve → generator LLM → judge LLM → 0/1.
//     Supermemory 81.6%, Hindsight 91.4% are THIS metric.
//     We don't implement it; see devnotes/metrics/metric-discipline.md.
//
// ABSTENTION
//   Questions with empty answer_session_ids (abstention in the LME paper)
//   return null from all session-id metrics, excluded from the average.
//   Our longmemeval_s_cleaned.json is pre-filtered to 500 non-abstention
//   questions; the null path is a defensive guard.

/** Returns true iff the memory text covers ≥50% of the ground-truth tokens. */
function memoryHitsTruth(text: string, truthTokens: string[]): boolean {
  if (truthTokens.length === 0) return true;
  const memTokens = new Set(tokenize(text));
  const hits = truthTokens.filter(t => memTokens.has(t)).length;
  return hits / truthTokens.length >= 0.5;
}

/** Content-overlap recall@K — lotl-specific, NOT comparable with competitors. */
function computeContentRecallAtK(memories: { text: string }[], groundTruth: string, k: number): number {
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

/** Content-overlap MRR — lotl-specific, NOT comparable with competitors. */
function computeContentMRR(memories: { text: string }[], groundTruth: string, k: number): number {
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

/** Content-overlap NDCG@K — lotl-specific, NOT comparable with competitors. */
function computeContentNDCG(memories: { text: string }[], groundTruth: string, k: number): number {
  const truthTokens = tokenize(groundTruth);
  if (truthTokens.length === 0) return 1;
  const topK = memories.slice(0, k);
  if (topK.length === 0) return 0;
  const rels = topK.map(m => (memoryHitsTruth(m.text, truthTokens) ? 1 : 0));
  const totalRel = rels.reduce((a: number, b: number) => a + b, 0);
  if (totalRel === 0) return 0;
  let dcg = 0;
  for (let i = 0; i < rels.length; i++) {
    if (rels[i] === 1) dcg += 1 / Math.log2(i + 2);
  }
  let idcg = 0;
  for (let i = 0; i < totalRel; i++) {
    idcg += 1 / Math.log2(i + 2);
  }
  return idcg > 0 ? dcg / idcg : 0;
}

// -----------------------------------------------------------------------------
// Session-based retrieval metrics — shared helpers + strict implementations
// per devnotes/metrics/metric-discipline.md and the LongMemEval paper.

/** Extract source_session_id from one memory's metadata JSON, or null. */
function sessionIdOf(mem: { metadata?: string | null }): string | null {
  if (!mem.metadata) return null;
  try {
    const meta = JSON.parse(mem.metadata) as { source_session_id?: string };
    return meta.source_session_id ?? null;
  } catch { return null; }
}

/**
 * Deduplicate a memory list by source_session_id, keeping the HIGHEST rank
 * (lowest position) for each unique session. Returns parallel arrays of
 * [positions, sessionIds] — positions is 0-indexed position in the ORIGINAL
 * top-K list, kept so NDCG's position discount is accurate even when the
 * same session appears multiple times in the raw retrieval.
 */
function dedupBySession(
  memories: Array<{ metadata?: string | null }>,
  k: number,
): { positions: number[]; sessionIds: string[] } {
  const seen = new Set<string>();
  const positions: number[] = [];
  const sessionIds: string[] = [];
  const topK = memories.slice(0, k);
  for (let i = 0; i < topK.length; i++) {
    const sid = sessionIdOf(topK[i]!);
    if (!sid || seen.has(sid)) continue;
    seen.add(sid);
    positions.push(i);
    sessionIds.push(sid);
  }
  return { positions, sessionIds };
}

/**
 * recall_any@K — BINARY: 1 if any gold session appears in deduped top-K,
 * else 0. Returns null for abstention questions (empty answer_session_ids).
 * Matches what agentmemory / mem0 / MemPalace publish as "R@K".
 */
function computeSessionRecallAnyAtK(
  memories: Array<{ metadata?: string | null }>,
  answerSessionIds: string[],
  k: number,
): number | null {
  if (answerSessionIds.length === 0) return null;
  const correct = new Set(answerSessionIds);
  const { sessionIds } = dedupBySession(memories, k);
  for (const sid of sessionIds) {
    if (correct.has(sid)) return 1;
  }
  return 0;
}

/**
 * R@K — FRACTIONAL recall per the LongMemEval paper:
 *   |gold ∩ retrieved_top_k_sessions| / |gold|
 * Returns null for abstention questions.
 */
function computeSessionRecallAtK(
  memories: Array<{ metadata?: string | null }>,
  answerSessionIds: string[],
  k: number,
): number | null {
  if (answerSessionIds.length === 0) return null;
  const gold = new Set(answerSessionIds);
  const { sessionIds } = dedupBySession(memories, k);
  const retrieved = new Set(sessionIds);
  let hits = 0;
  for (const g of gold) {
    if (retrieved.has(g)) hits++;
  }
  return hits / gold.size;
}

/**
 * Session-id MRR — 1 / rank of the first gold session in the DEDUPED
 * top-K list. Uses the deduped position so identical repeated sessions
 * don't inflate the rank.
 */
function computeSessionMRR(
  memories: Array<{ metadata?: string | null }>,
  answerSessionIds: string[],
  k: number,
): number | null {
  if (answerSessionIds.length === 0) return null;
  const correct = new Set(answerSessionIds);
  const { positions, sessionIds } = dedupBySession(memories, k);
  for (let i = 0; i < sessionIds.length; i++) {
    if (correct.has(sessionIds[i]!)) {
      // Use the ORIGINAL position (preserves rank-discount semantics),
      // not the deduped position.
      return 1 / (positions[i]! + 1);
    }
  }
  return 0;
}

/**
 * Session-id NDCG@K with binary relevance. Deduplicates by session_id
 * (so a session counted once even if multiple chunks retrieved). IDCG is
 * computed against the PER-QUESTION gold count via min(k, |gold|) — this
 * is the fix for the common bug where IDCG uses found-in-retrieval count
 * instead of total gold count, which makes multi-session NDCG collapse
 * to MRR.
 */
function computeSessionNDCG(
  memories: Array<{ metadata?: string | null }>,
  answerSessionIds: string[],
  k: number,
): number | null {
  if (answerSessionIds.length === 0) return null;
  const gold = new Set(answerSessionIds);
  const { positions, sessionIds } = dedupBySession(memories, k);
  // DCG — gain at ORIGINAL position for each unique gold session found
  let dcg = 0;
  for (let i = 0; i < sessionIds.length; i++) {
    if (gold.has(sessionIds[i]!)) {
      dcg += 1 / Math.log2(positions[i]! + 2);
    }
  }
  // IDCG — ideal ranking puts min(K, |gold|) gold sessions at positions 0..
  const idealCount = Math.min(k, gold.size);
  let idcg = 0;
  for (let i = 0; i < idealCount; i++) {
    idcg += 1 / Math.log2(i + 2);
  }
  return idcg > 0 ? dcg / idcg : 0;
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
  let idsFilePath: string | null = null;   // --ids-file: subset dataset by question_id

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--ds" && args[i + 1]) dsName = args[i + 1]!;
    if (args[i] === "--limit" && args[i + 1]) limit = parseInt(args[i + 1]!, 10);
    if (args[i] === "--type" && args[i + 1]) questionTypeFilter = args[i + 1]!;
    // --ids-file <path>: subset the dataset to only questions whose question_id
    // appears in the given JSON file (a flat array of strings). Useful for
    // re-running ONLY the previously-failing questions after a config tweak.
    if (args[i] === "--ids-file" && args[i + 1]) idsFilePath = args[i + 1]!;
    if (args[i] === "--llm" && args[i + 1]) activeLLM = args[i + 1] as LLMProvider;
    if (args[i] === "--judge" && args[i + 1]) judgeProvider = args[i + 1] as LLMProvider;
    if (args[i] === "--judge-model" && args[i + 1]) judgeModelOverride = args[i + 1]!;
    // Enable the `memoryReflect` pre-pass (distil top-K memories into facts before
    // the answer call). Maps to LOTL_RECALL_REFLECT=on internally.
    if (args[i] === "--reflect") process.env.LOTL_RECALL_REFLECT = "on";
    if (args[i] === "--tag" && args[i + 1]) resultsTag = args[i + 1]!;
    if (args[i] === "--db-suffix" && args[i + 1]) dbSuffix = "-" + args[i + 1];
    if (args[i] === "--no-llm") useLLM = false;
    // cat D: override LLM model for A-B testing — sets BOTH extract and answer model
    if (args[i] === "--model" && args[i + 1]) {
      const m = args[i + 1]!;
      LLM_CONFIG.gemini.model = m;
      LLM_CONFIG.gemini.url = geminiUrl(m);
      // Also override the extraction model used by chatComplete in src/llm.ts
      process.env.LOTL_QUERY_EXPANSION_MODEL = m;
    }
    // --answer-model: override only the answer-generation model (cat D split)
    if (args[i] === "--answer-model" && args[i + 1]) {
      const m = args[i + 1]!;
      LLM_CONFIG.gemini.model = m;
      LLM_CONFIG.gemini.url = geminiUrl(m);
    }
    // --extract-model was here historically but it pointed at LOTL_QUERY_EXPANSION_MODEL
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
      process.env.LOTL_LME_WORKERS = args[i + 1]!;
    }
  }

  if (useLLM && !process.env[LLM_CONFIG[activeLLM].keyEnv]) {
    console.error(`Set ${LLM_CONFIG[activeLLM].keyEnv} or use --no-llm`);
    process.exit(1);
  }

  // Pre-flight: probe generator + judge providers with a 1-token ping so a
  // low-quota account fails fast, not at question 42 of 100. Fatal if it
  // throws — caller (sweep script / user) can retry after topping up.
  if (useLLM) {
    await preflightQuotaCheck(activeLLM, LLM_CONFIG[activeLLM].model);
  }
  if (judgeProvider) {
    const judgeModel = judgeModelOverride || LLM_CONFIG[judgeProvider].model;
    await preflightQuotaCheck(judgeProvider, judgeModel);
  }

  // --ds s now prefers the huggingface-released longmemeval_s_cleaned.json
  // (277 MB, 500 questions with full distractor haystack). Falls back to the
  // original longmemeval_s.json if cleaned isn't present.
  const sPreferred = join(LOTL_DIR, "evaluate/longmemeval", "longmemeval_s_cleaned.json");
  const sFallback = join(LOTL_DIR, "evaluate/longmemeval", "longmemeval_s.json");
  const sPath = existsSync(sPreferred) ? sPreferred : sFallback;
  const dataPath = dsName === "s"
    ? sPath
    : join(LOTL_DIR, "evaluate/longmemeval", "longmemeval_oracle.json");
  console.log(`\n  Loading ${dataPath}...`);
  const data: LMEInstance[] = JSON.parse(readFileSync(dataPath, "utf-8"));
  console.log(`  Loaded ${data.length} instances`);

  let instances = data;
  if (questionTypeFilter) instances = instances.filter(q => q.question_type === questionTypeFilter);
  if (idsFilePath) {
    const ids = JSON.parse(readFileSync(idsFilePath, "utf8")) as string[];
    const idSet = new Set(ids);
    const before = instances.length;
    instances = instances.filter(q => idSet.has(q.question_id));
    console.log(`  Filtered to ${instances.length}/${before} questions from ${idsFilePath}`);
  }
  if (limit > 0) instances = instances.slice(0, limit);
  // cat E: shard the question list — each shard processes every Nth question starting at shardIdx
  if (shardTotal > 1) {
    instances = instances.filter((_, idx) => idx % shardTotal === shardIdx);
    console.log(`  Sharding: this is shard ${shardIdx}/${shardTotal} → ${instances.length} questions`);
  }
  console.log(`  Running: ${instances.length} questions${questionTypeFilter ? ` (type=${questionTypeFilter})` : ""}`);

  const ablation = {
    INGEST_SYNTHESIS: process.env.LOTL_INGEST_SYNTHESIS !== "off",
    INGEST_REFLECTIONS: process.env.LOTL_INGEST_REFLECTIONS !== "off",
    PROMPT_RULES: process.env.LOTL_PROMPT_RULES || "v11",
    MEMORY_MMR: process.env.LOTL_MEMORY_MMR === "session",
  };
  console.log(`  Ablation: ${JSON.stringify(ablation)}\n`);

  // One DB per shard so SQLite WAL doesn't contend across workers
  const dbDir = join(LOTL_DIR, "evaluate/longmemeval/dbs");
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

  // Hoisted output path so per-question loop can incrementally persist
  // partial results. Final write at end of main() rewrites with full summary.
  // Atomic via writeFileSync(tmp) + renameSync — safe against kill mid-write.
  const outName = resultsTag ? `results-${resultsTag}.json` : "results.json";
  const outPath = join(LOTL_DIR, "evaluate/longmemeval", outName);
  const PARTIAL_SAVE_EVERY = parseInt(process.env.LOTL_EVAL_PARTIAL_EVERY || "10", 10);

  function savePartial() {
    const partial = {
      partial: true,
      progress: { completed: allResults.length, total: instances.length },
      results: allResults,
    };
    try {
      writeFileSync(outPath + ".tmp", JSON.stringify(partial));
      renameSync(outPath + ".tmp", outPath);
    } catch (e) {
      process.stderr.write(`\n[partial-save] failed: ${e}\n`);
    }
  }

  // Per-question handler — pure function, safe to run concurrently.
  // Workers share the SQLite db; better-sqlite3 calls block the JS thread
  // briefly but await calls (LLM, embed) suspend so other workers run.
  async function processQuestion(inst: LMEInstance): Promise<void> {
    const scope = inst.question_id;

    // --- INGEST sessions for this question (skip if already ingested under this scope) ---
    const existingCount = (db.prepare(`SELECT COUNT(*) as n FROM memories WHERE scope = ?`).get(scope) as any)?.n || 0;
    if (existingCount === 0) {
      const storeTurns = process.env.LOTL_INGEST_PER_TURN !== "off";
      const storeSessions = process.env.LOTL_INGEST_SESSION_AS_MEMORY !== "off";
      const batchExtract = process.env.LOTL_INGEST_BATCH_EXTRACT !== "off";
      // L1 (user-turns-only) ingest from Schift's L# cache pattern. When on,
      // the session-level memory text is built from user turns only,
      // stripping the assistant's verbose responses so the embedding
      // centroid focuses on the user's preference statements.
      const userOnlySession = process.env.LOTL_INGEST_USER_ONLY === "on";

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
        const sessionText = turnsToText(turns, userOnlySession);
        if (storeSessions && date) {
          turnBatch.push({ text: `[${date}]\n${sessionText}`, scope, importance: 0.7, metadata: { source_session_id: sessionId } });
        }
        sessionTexts.push(date ? `[${date}]\n${sessionText}` : sessionText);
        if (!batchExtract && process.env.LOTL_INGEST_EXTRACTION !== "off") {
          try { await extractAndStore(db, sessionText, scope, { source_session_id: sessionId }); } catch { /* skip */ }
        }
      }

      if (turnBatch.length > 0) {
        try { await memoryStoreBatch(db, turnBatch); } catch (e) {
          for (const item of turnBatch) { try { await memoryStore(db, item); } catch {} }
        }
      }

      if (batchExtract && process.env.LOTL_INGEST_EXTRACTION !== "off") {
        try { await extractAndStore(db, sessionTexts.join("\n\n---\n\n"), scope); } catch { /* skip */ }
      }
      if (process.env.LOTL_INGEST_SYNTHESIS !== "off") {
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
    // LOTL_RECALL_REFLECT=on. Adds one extra LLM call per question.
    //
    // v16.1 fix: AUGMENT the memory list with the reflection block at
    // the top — don't REPLACE it. v16-full shipped replacement and lost
    // ~20pp F1 on LME because the compressed bullets dropped exact
    // wording the answer model needed for date arithmetic and ordering.
    // Cap memories passed to the answer LLM. Retrieval still returns 50 for
    // metric computation (MRR@50, R@50), but the answer prompt only needs the
    // top-k. Default 5 matches LongMemEval paper and mem0/letta norms.
    //
    // Per-memory char cap: LongMemEval memories are often full multi-turn
    // sessions (avg ~8K chars, max ~40K). An 800-char cap drops 90% of the
    // content and causes gpt-4o to answer "no information available" even
    // when the right session is retrieved (found during Phase 7.1 probe —
    // Judge stuck at 27% until the cap was raised). 6000 chars × top-5 ≈
    // 30K chars ≈ 7.5K input tokens per question — fits every major model's
    // context window, still under 10K/question token budget.
    const ANSWER_TOP_K = Number(process.env.LOTL_ANSWER_TOP_K ?? 10);
    const ANSWER_MAX_CHARS = Number(process.env.LOTL_ANSWER_MAX_CHARS ?? 6000);
    let answerMemories = memories
      .slice(0, ANSWER_TOP_K)
      .map(m => m.text.length > ANSWER_MAX_CHARS ? m.text.slice(0, ANSWER_MAX_CHARS) + "…" : m.text);
    if (process.env.LOTL_RECALL_REFLECT === "on" && memories.length > 0 && useLLM) {
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
        // Pre-flight estimate: 1 token ≈ 4 chars. Warn if the prompt is
        // suspiciously large (was a 91k-token blowup on n=100 before the
        // top-K cap landed). Cheap defensive log — doesn't affect behaviour.
        const estTok = Math.ceil(prompt.length / 4);
        if (estTok > 8000) {
          process.stderr.write(`\n[warn] answer prompt ~${estTok} tokens (${answerMemories.length} memories). Consider lowering LOTL_ANSWER_TOP_K or LOTL_ANSWER_MAX_CHARS.\n`);
        }
        // v14 CoT produces ~1500–2500 output tokens (7-step scaffold + final answer).
        // Other prompts stay at 128 default for paid providers. LOTL_ANSWER_MAX_TOKENS
        // is a FLOOR — it bumps v11 up without capping v14 below its CoT need. Needed
        // for local thinking models (gemma-4-e4b burns ~100+ reasoning tokens before
        // emitting content even on v11 prompts).
        const defaultMax = process.env.LOTL_PROMPT_RULES === "v14" ? 2560 : 128;
        const envFloor = Number(process.env.LOTL_ANSWER_MAX_TOKENS ?? 0);
        const answerMaxTokens = Math.max(envFloor, defaultMax);
        const raw = await askLLM(prompt, activeLLM, answerMaxTokens);
        // For v14 extract the FINAL ANSWER section; fall back to raw trailing text
        // if the model skipped the tag. F1/EM/SH scoring on the scaffold would
        // explode because it includes the gold tokens verbatim in STEP 2.
        const extracted = process.env.LOTL_PROMPT_RULES === "v14" ? extractFinalAnswer(raw) : raw;
        prediction = extracted;
        // Persist {question, prompt, raw, extracted, model, hash} so a later
        // judge pass (e.g. Poe, LM Studio qwen) can rescore without re-running
        // generation. See persistAnswer() for path + schema.
        try { await persistAnswer(inst.question_id, inst.question, prompt, raw, extracted, activeLLM); } catch { /* best-effort */ }
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
    // LLM-as-judge verdict (null when --judge not set, or on abstention, or on judge error).
    const judgeCorrect = (judgeProvider && gt && prediction)
      ? await askJudge(inst.question, prediction, gt)
      : null;
    const sessionIds = inst.answer_session_ids || [];
    // PRIMARY (session-id retrieval):
    //   r_any@K = binary recall_any — matches agentmemory/mem0/MemPalace "R@K"
    //   r@K     = fractional recall  — matches LongMemEval paper definition
    // Both return null on abstention (empty gold); excluded from averages.
    const r_any5 = computeSessionRecallAnyAtK(memories, sessionIds, 5);
    const r_any10 = computeSessionRecallAnyAtK(memories, sessionIds, 10);
    const r_any20 = computeSessionRecallAnyAtK(memories, sessionIds, 20);
    const r5 = computeSessionRecallAtK(memories, sessionIds, 5);
    const r10 = computeSessionRecallAtK(memories, sessionIds, 10);
    const r15 = computeSessionRecallAtK(memories, sessionIds, 15);
    const r20 = computeSessionRecallAtK(memories, sessionIds, 20);
    const r50 = computeSessionRecallAtK(memories, sessionIds, 50);
    const mrr = computeSessionMRR(memories, sessionIds, 10);
    const ndcg10 = computeSessionNDCG(memories, sessionIds, 10);

    // SECONDARY (lotl-specific content-overlap proxy — NOT comparable externally)
    const cov_r5 = computeContentRecallAtK(memories, gt, 5);
    const cov_r10 = computeContentRecallAtK(memories, gt, 10);
    const cov_r20 = computeContentRecallAtK(memories, gt, 20);
    const cov_mrr = computeContentMRR(memories, gt, 10);
    const cov_ndcg10 = computeContentNDCG(memories, gt, 10);
    runningF1 += f1;
    completed++;

    allResults.push({
      question_id: inst.question_id,
      question_type: inst.question_type,
      question: inst.question,
      answer: gt,
      prediction: prediction.slice(0, 300),
      memoriesFound: memories.length,
      is_abstention: sessionIds.length === 0,
      f1, em, sh,
      // PRIMARY — session-id retrieval
      r_any5, r_any10, r_any20,  // binary recall_any@K (agentmemory/mem0/MemPalace convention)
      r5, r10, r15, r20, r50,     // fractional R@K (LongMemEval paper convention)
      mrr, ndcg10,
      // SECONDARY — content overlap (lotl-specific)
      cov_r5, cov_r10, cov_r20, cov_mrr, cov_ndcg10,
      // PHASE 7 — LLM-as-judge binary correctness (null when judge not run)
      judgeCorrect,
      searchMs, answerMs,
    });

    if (allResults.length % PARTIAL_SAVE_EVERY === 0) savePartial();

    process.stdout.write(`\r  ${progressBar(completed, instances.length)} F1=${(runningF1 / completed * 100).toFixed(1)}% mem=${memories.length} search=${searchMs}ms ${elapsed(globalStart)}`);
  }

  // Worker pool: N concurrent workers pulling from a shared index queue.
  // LOTL_LME_WORKERS=1 (default) preserves the original sequential behavior.
  const concurrency = Math.max(1, parseInt(process.env.LOTL_LME_WORKERS || "1", 10));
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
  // Abstention-aware averager: skips null values (abstention questions)
  // from both numerator and denominator. Our longmemeval_s_cleaned.json
  // has 0 abstention so this is defensive; matters if we ever switch
  // datasets.
  const avgNullable = <T extends Record<string, any>>(rows: T[], key: keyof T): number => {
    let sum = 0;
    let count = 0;
    for (const r of rows) {
      const v = r[key];
      if (v !== null && v !== undefined) { sum += v as number; count++; }
    }
    return count > 0 ? sum / count : 0;
  };

  const n = allResults.length;
  const nonAbstention = allResults.filter(r => !r.is_abstention);
  const nEval = nonAbstention.length;
  const avgF1 = allResults.reduce((s, r) => s + r.f1, 0) / n;
  const avgEM = allResults.reduce((s, r) => s + r.em, 0) / n;
  const avgSH = allResults.reduce((s, r) => s + r.sh, 0) / n;
  // LLM-judge accuracy — only averaged over questions that got a verdict.
  const judged = allResults.filter(r => typeof (r as any).judgeCorrect === "number");
  const avgJudgeCorrect = judged.length > 0
    ? judged.reduce((s, r) => s + ((r as any).judgeCorrect as number), 0) / judged.length
    : null;
  const judgeN = judged.length;
  // PRIMARY — session-id retrieval (skip abstention)
  const avgRAny5 = avgNullable(allResults, "r_any5");
  const avgRAny10 = avgNullable(allResults, "r_any10");
  const avgRAny20 = avgNullable(allResults, "r_any20");
  const avgR5 = avgNullable(allResults, "r5");
  const avgR10 = avgNullable(allResults, "r10");
  const avgR15 = avgNullable(allResults, "r15");
  const avgR20 = avgNullable(allResults, "r20");
  const avgR50 = avgNullable(allResults, "r50");
  const avgMRR = avgNullable(allResults, "mrr");
  const avgNDCG10 = avgNullable(allResults, "ndcg10");
  // SECONDARY (content-overlap proxy — lotl-specific)
  const avgCovR5 = allResults.reduce((s, r) => s + r.cov_r5, 0) / n;
  const avgCovR10 = allResults.reduce((s, r) => s + r.cov_r10, 0) / n;
  const avgCovR20 = allResults.reduce((s, r) => s + r.cov_r20, 0) / n;
  const avgCovMRR = allResults.reduce((s, r) => s + r.cov_mrr, 0) / n;
  const avgCovNDCG10 = allResults.reduce((s, r) => s + r.cov_ndcg10, 0) / n;

  console.log(`${"=".repeat(72)}`);
  console.log(`  LONGMEMEVAL FINAL  (ds=${dsName}, n=${n}, non-abstention=${nEval})`);
  console.log(`${"=".repeat(72)}`);
  console.log(`  PRIMARY — session-id retrieval (deduped by session, per-question IDCG, abstention excluded)`);
  console.log(`    recall_any@5:  ${(avgRAny5 * 100).toFixed(1)}%   ← matches agentmemory/mem0/MemPalace "R@5"`);
  console.log(`    recall_any@10: ${(avgRAny10 * 100).toFixed(1)}%`);
  console.log(`    recall_any@20: ${(avgRAny20 * 100).toFixed(1)}%`);
  console.log(`    R@5:     ${(avgR5 * 100).toFixed(1)}%   ← LongMemEval paper definition (fractional)`);
  console.log(`    R@10:    ${(avgR10 * 100).toFixed(1)}%`);
  console.log(`    R@15:    ${(avgR15 * 100).toFixed(1)}%`);
  console.log(`    R@20:    ${(avgR20 * 100).toFixed(1)}%`);
  console.log(`    R@50:    ${(avgR50 * 100).toFixed(1)}%`);
  console.log(`    MRR:     ${avgMRR.toFixed(3)}`);
  console.log(`    NDCG@10: ${avgNDCG10.toFixed(3)}`);
  console.log(`  SECONDARY — content-overlap coverage (lotl-specific; NOT comparable with competitors)`);
  console.log(`    Cov@5:       ${(avgCovR5 * 100).toFixed(1)}%`);
  console.log(`    Cov@10:      ${(avgCovR10 * 100).toFixed(1)}%`);
  console.log(`    Cov@20:      ${(avgCovR20 * 100).toFixed(1)}%`);
  console.log(`    Cov-MRR:     ${avgCovMRR.toFixed(3)}`);
  console.log(`    Cov-NDCG@10: ${avgCovNDCG10.toFixed(3)}`);
  console.log(`  Answer quality (when --no-llm, these use raw memory text concat as "prediction")`);
  console.log(`    F1:     ${(avgF1 * 100).toFixed(1)}%   (token overlap, fuzzy)`);
  console.log(`    EM:     ${(avgEM * 100).toFixed(1)}%   (exact match, strict)`);
  console.log(`    SH:     ${(avgSH * 100).toFixed(1)}%   (substring hit — catches short-answer EM false negatives)`);
  if (avgJudgeCorrect !== null) {
    console.log(`    Judge:  ${(avgJudgeCorrect * 100).toFixed(1)}%   (LLM-as-judge binary correctness, n=${judgeN} via ${judgeProvider})`);
  }
  if (usageTotals.callsGen + usageTotals.callsJudge > 0) {
    console.log(`  LLM usage:`);
    console.log(`    Gen calls:   ${usageTotals.callsGen}`);
    console.log(`    Judge calls: ${usageTotals.callsJudge}`);
    console.log(`    Tokens:      ${usageTotals.input.toLocaleString()} input / ${usageTotals.output.toLocaleString()} output`);
    const perQ = (usageTotals.input + usageTotals.output) / Math.max(1, usageTotals.callsGen + usageTotals.callsJudge);
    console.log(`    Avg per call: ${perQ.toFixed(0)} tokens`);
  }
  console.log(`  Time: ${elapsed(globalStart)}`);

  console.log(`\n  By question type — recall_any@5 / R@5 (fractional) / R@10 / MRR / NDCG@10 / Cov@5 / F1`);
  const types = [...new Set(allResults.map(r => r.question_type))].sort();
  for (const qt of types) {
    const qrs = allResults.filter(r => r.question_type === qt);
    const f1 = qrs.reduce((s, r) => s + r.f1, 0) / qrs.length;
    const rAny5 = avgNullable(qrs, "r_any5");
    const r5 = avgNullable(qrs, "r5");
    const r10 = avgNullable(qrs, "r10");
    const r20 = avgNullable(qrs, "r20");
    const ndcg10 = avgNullable(qrs, "ndcg10");
    const mrr = avgNullable(qrs, "mrr");
    const cov5 = qrs.reduce((s, r) => s + r.cov_r5, 0) / qrs.length;
    console.log(`    ${qt.padEnd(24)} (n=${String(qrs.length).padStart(4)}): rAny5=${(rAny5 * 100).toFixed(0).padStart(3)}% R@5=${(r5 * 100).toFixed(0).padStart(3)}% R@10=${(r10 * 100).toFixed(0).padStart(3)}% R@20=${(r20 * 100).toFixed(0).padStart(3)}% MRR=${mrr.toFixed(3)} NDCG@10=${ndcg10.toFixed(3)} Cov@5=${(cov5 * 100).toFixed(0).padStart(3)}% F1=${(f1 * 100).toFixed(1).padStart(5)}%`);
  }

  // Final save — outPath already declared above for incremental partial saves.
  // This rewrites the file with the full summary block (no `partial: true`).
  writeFileSync(outPath, JSON.stringify({
    config: { ds: dsName, useLLM, model: useLLM ? LLM_CONFIG[activeLLM].model : "none", llm: activeLLM, limit, questionTypeFilter, ablation },
    summary: {
      // PRIMARY — session-id retrieval
      avgRAny5, avgRAny10, avgRAny20,    // binary recall_any
      avgR5, avgR10, avgR15, avgR20, avgR50,  // fractional R@K (paper definition)
      avgMRR, avgNDCG10,
      // SECONDARY — content-overlap (lotl-specific)
      avgCovR5, avgCovR10, avgCovR20, avgCovMRR, avgCovNDCG10,
      // Answer quality
      avgF1, avgEM, avgSH,
      avgJudgeCorrect, judgeN, judgeProvider,
      llmUsage: { ...usageTotals },
      total: n, nonAbstention: nEval,
    },
    results: allResults,
  }, null, 2));
  console.log(`\n  Saved: ${outPath}`);

  db.close();
}

main().catch(e => { console.error(e); process.exit(1); });
