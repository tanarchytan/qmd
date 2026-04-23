#!/usr/bin/env node
/**
 * Adversarial plausibility baseline generator (#36).
 *
 * Judge leniency test: if our LLM judge says "correct" for our answers, does
 * it ALSO say "correct" for deliberately wrong answers that sound plausible?
 * If yes, the judge is a rubber-stamp. If no, we have real signal.
 *
 * Two distractor variants per question:
 *   v1 — specific-wrong: a different concrete answer in the same shape as
 *        the gold (if gold is a date, return a different date; if gold is a
 *        name, return a different name). Must SOUND like a real answer from
 *        the memories. Tests whether the judge accepts "confidently wrong".
 *   v2 — vague-topical: acknowledges the topic but dodges the question
 *        ("they discussed this during the meeting", no commitment). Tests
 *        whether the judge accepts non-answers.
 *
 * Pipeline (run tonight when LM Studio is back):
 *   1. Read golden answers + memories from a Phase-B results JSON
 *   2. For each question, LLM-generate v1 + v2 wrong answers
 *   3. Write adversarial-answers.json with {qid, golden, v1_wrong, v2_wrong}
 *   4. Re-run judge over v1 + v2 predictions
 *   5. Compare judge accuracy on gold vs v1 vs v2
 *
 * Expected outcome: strict judge accepts <10% of v1 and <5% of v2.
 * If acceptance rate is much higher, judge is too lenient → retune gate.
 *
 * Usage:
 *   node evaluate/scripts/adversarial-gen.mjs \
 *     evaluate/longmemeval/results-phase-b-lme-v14-gemma-pass1.json \
 *     --provider lmstudio \
 *     --model google/gemma-4-e4b \
 *     --out evaluate/longmemeval/adversarial-answers.json \
 *     [--limit 50]  # smoke-test cap
 *
 * LLM HOOK (tonight): `callLLM(prompt)` is stubbed below — fill with either
 * the lmstudio/v1/chat/completions POST or the shared llm-cache chatComplete
 * call once LM Studio is back. All other logic is LLM-independent.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const ADVERSARIAL_PROMPT_V1 = (question, golden, memories) => `You are generating deliberately WRONG answers for a retrieval-evaluation adversarial test. The judge should detect these as wrong. Your job is to sound plausible but be factually incorrect.

Question: ${question}
Correct answer: ${golden}

Relevant memories (these mention the topic but NOT the correct answer):
${memories.slice(0, 5).map((m, i) => `[${i + 1}] ${String(m).slice(0, 400)}`).join("\n")}

Rules:
- Produce ONE short answer (≤30 words) that looks structurally like a valid answer.
- If the correct answer is a date, return a DIFFERENT date. If a name, DIFFERENT name. If a number, DIFFERENT number. If a fact, a plausible-but-WRONG fact.
- Do NOT hedge, do NOT say "I'm not sure". Sound confident.
- Do NOT give the correct answer or anything semantically equivalent.

Respond with a JSON object: {"wrong_answer": "<the confidently wrong answer>"}`;

const ADVERSARIAL_PROMPT_V2 = (question, golden, memories) => `You are generating deliberately VAGUE non-answers for a retrieval-evaluation adversarial test. A strict judge should detect these as non-answers. Your job is to acknowledge the topic but dodge the question.

Question: ${question}
Correct answer: ${golden}

Relevant memories:
${memories.slice(0, 5).map((m, i) => `[${i + 1}] ${String(m).slice(0, 400)}`).join("\n")}

Rules:
- Produce ONE short response (≤30 words) that mentions the topic but NEVER commits to a specific answer.
- Use phrasing like "they discussed this", "it came up in conversation", "various options were considered".
- Do NOT give the correct answer or any concrete alternative.

Respond with a JSON object: {"wrong_answer": "<the vague non-answer>"}`;

// ---------------------------------------------------------------------------
// LLM call — STUB for now. Fill this when LM Studio is back.
// ---------------------------------------------------------------------------
async function callLLM({ prompt, provider, model, host }) {
  if (provider !== "lmstudio") {
    throw new Error(`Only lmstudio provider wired; got ${provider}. Add a remote branch here.`);
  }
  const body = {
    model,
    messages: [{ role: "user", content: prompt }],
    temperature: 0.3,
    max_tokens: 128,
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "wrong_answer",
        strict: true,
        schema: {
          type: "object",
          properties: { wrong_answer: { type: "string" } },
          required: ["wrong_answer"],
          additionalProperties: false,
        },
      },
    },
    seed: 42,
  };
  const resp = await fetch(`http://${host}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.LOTL_LMSTUDIO_KEY || "lm-studio"}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(`lmstudio ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  const data = await resp.json();
  // Thinking-model fallback: qwen3.6 routes structured output into reasoning_content.
  const msg = data.choices?.[0]?.message;
  const raw = (msg?.content && msg.content.length > 0) ? msg.content : (msg?.reasoning_content ?? "");
  try {
    const obj = JSON.parse(raw);
    if (typeof obj.wrong_answer === "string") return obj.wrong_answer.trim();
  } catch { /* fall through */ }
  // Last-resort: treat the whole response as the wrong answer
  return raw.trim().slice(0, 200);
}

function parseArgs(argv) {
  const args = { inputPath: argv[2], provider: "lmstudio", model: process.env.LOTL_LMSTUDIO_GEN_MODEL || "google/gemma-4-e4b", host: process.env.LOTL_LMSTUDIO_HOST || "localhost:1234", out: "", limit: Infinity };
  for (let i = 3; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--provider") args.provider = argv[++i];
    else if (a === "--model") args.model = argv[++i];
    else if (a === "--host") args.host = argv[++i];
    else if (a === "--out") args.out = argv[++i];
    else if (a === "--limit") args.limit = Number(argv[++i]);
  }
  if (!args.inputPath) {
    console.error("usage: adversarial-gen.mjs <results.json> [--provider lmstudio] [--model X] [--host H] [--out OUT] [--limit N]");
    process.exit(2);
  }
  if (!args.out) args.out = args.inputPath.replace(/\.json$/, ".adversarial.json");
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  if (!existsSync(args.inputPath)) {
    console.error(`Input not found: ${args.inputPath}`);
    process.exit(1);
  }
  const data = JSON.parse(readFileSync(args.inputPath, "utf8"));
  const items = Array.isArray(data?.items) ? data.items
    : Array.isArray(data?.results) ? data.results
    : Array.isArray(data?.rows) ? data.rows
    : Array.isArray(data) ? data
    : [];
  if (items.length === 0) {
    console.error(`No items found in ${args.inputPath}`);
    process.exit(1);
  }
  const out = [];
  const total = Math.min(items.length, args.limit);
  console.log(`[adversarial] generating wrong answers for ${total} items via ${args.provider} (${args.model})`);
  for (let i = 0; i < total; i++) {
    const it = items[i];
    const qid = it.question_id ?? it.qid ?? it.id ?? `idx-${i}`;
    const question = it.question ?? it.q ?? "";
    const golden = it.golden ?? it.gold ?? it.answer ?? "";
    const memories = Array.isArray(it.memories)
      ? it.memories.map((m) => m.content ?? m.text ?? String(m))
      : Array.isArray(it.retrieved)
        ? it.retrieved.map((m) => m.content ?? m.text ?? String(m))
        : [];
    try {
      const v1 = await callLLM({ prompt: ADVERSARIAL_PROMPT_V1(question, golden, memories), provider: args.provider, model: args.model, host: args.host });
      const v2 = await callLLM({ prompt: ADVERSARIAL_PROMPT_V2(question, golden, memories), provider: args.provider, model: args.model, host: args.host });
      out.push({ qid, question, golden, v1_wrong: v1, v2_wrong: v2 });
      if ((i + 1) % 25 === 0) console.log(`  [${i + 1}/${total}] last v1="${v1.slice(0, 60)}..."`);
    } catch (err) {
      console.error(`  [${i + 1}/${total}] failed: ${err instanceof Error ? err.message : err}`);
      out.push({ qid, question, golden, v1_wrong: null, v2_wrong: null, error: String(err) });
    }
  }
  mkdirSync(dirname(args.out), { recursive: true });
  writeFileSync(args.out, JSON.stringify({ source: args.inputPath, model: args.model, generated_at: new Date().toISOString(), items: out }, null, 2));
  console.log(`[adversarial] wrote ${out.length} items → ${args.out}`);
  console.log(`[adversarial] next step: re-run the judge on v1_wrong/v2_wrong predictions, compare accuracy vs golden.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
