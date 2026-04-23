#!/usr/bin/env node
/**
 * Adversarial re-judge (#36 phase 2).
 *
 * Takes the adversarial-gen.mjs output and re-runs the same judge prompt
 * from eval.mts against v1_wrong and v2_wrong as if they were real
 * predictions. Reports the acceptance rate — how often the judge rubber-
 * stamped each distractor class.
 *
 * Healthy judge expectation (audit methodology):
 *   golden  accepted: >60% (we saw 73.8% on combined-winners)
 *   v1      accepted: <10%  (specific-wrong)
 *   v2      accepted:  <5%  (vague-topical)
 *
 * Usage:
 *   node evaluate/scripts/adversarial-rejudge.mjs \
 *     evaluate/longmemeval/results-phase-b-lme-v14-gemma-pass1.adversarial.json \
 *     [--host localhost:1234] [--model google/gemma-4-26b-a4b]
 */

import { readFileSync, writeFileSync } from "node:fs";

const JUDGE_SYSTEM =
  "You are a strict but fair grader. Given a question, a gold-standard answer, and a candidate answer, decide whether the candidate answer is factually equivalent to the gold. " +
  "CORRECT if the candidate expresses the same facts as the gold (different wording or extra non-contradictory detail is fine). " +
  "INCORRECT if any required fact is missing, contradicted, or has a different value. " +
  'Respond on one line with a single JSON object: {"correct": true|false, "reason": "<short sentence>"}';

const RESPONSE_SCHEMA = {
  type: "json_schema",
  json_schema: {
    name: "judge_verdict",
    strict: true,
    schema: {
      type: "object",
      properties: { correct: { type: "boolean" }, reason: { type: "string" } },
      required: ["correct", "reason"],
      additionalProperties: false,
    },
  },
};

function parseArgs(argv) {
  const args = {
    input: argv[2],
    host: process.env.LOTL_LMSTUDIO_HOST || "localhost:1234",
    model: process.env.LOTL_EVAL_LMSTUDIO_JUDGE_MODEL || process.env.LOTL_LMSTUDIO_JUDGE_MODEL || "google/gemma-4-26b-a4b",
  };
  for (let i = 3; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--host") args.host = argv[++i];
    else if (a === "--model") args.model = argv[++i];
  }
  if (!args.input) {
    console.error("usage: adversarial-rejudge.mjs <adversarial.json> [--host H] [--model M]");
    process.exit(2);
  }
  return args;
}

async function judge(question, golden, candidate, host, model) {
  const user = `Question: ${question}\nGold answer: ${golden}\nCandidate answer: ${candidate}`;
  const resp = await fetch(`http://${host}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.LOTL_LMSTUDIO_KEY || "lm-studio"}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: JUDGE_SYSTEM },
        { role: "user", content: user },
      ],
      temperature: 0,
      seed: 42,
      max_tokens: 768,
      response_format: RESPONSE_SCHEMA,
    }),
  });
  if (!resp.ok) throw new Error(`judge ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  const data = await resp.json();
  // Thinking-model fallback: qwen3.6 routes structured output into reasoning_content.
  const msg = data.choices?.[0]?.message;
  const raw = (msg?.content && msg.content.length > 0) ? msg.content : (msg?.reasoning_content ?? "");
  try {
    const m = raw.match(/\{[\s\S]*?\}/);
    if (m) {
      const obj = JSON.parse(m[0]);
      if (typeof obj.correct === "boolean") return obj.correct ? 1 : 0;
    }
  } catch { /* fall through */ }
  return null;
}

async function main() {
  const args = parseArgs(process.argv);
  const data = JSON.parse(readFileSync(args.input, "utf8"));
  const items = data.items ?? [];
  console.log(`[rejudge] ${items.length} items via ${args.model} @ ${args.host}`);

  let goldCorrect = 0, goldN = 0;
  let v1Accepted = 0, v1N = 0;
  let v2Accepted = 0, v2N = 0;
  const out = [];

  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (!it.question || !it.golden) continue;

    const [g, v1, v2] = await Promise.all([
      judge(it.question, it.golden, it.golden, args.host, args.model),      // self-check
      it.v1_wrong ? judge(it.question, it.golden, it.v1_wrong, args.host, args.model) : null,
      it.v2_wrong ? judge(it.question, it.golden, it.v2_wrong, args.host, args.model) : null,
    ]);

    if (g !== null) { goldN++; goldCorrect += g; }
    if (v1 !== null) { v1N++; v1Accepted += v1; }
    if (v2 !== null) { v2N++; v2Accepted += v2; }
    out.push({ qid: it.qid, gold: g, v1: v1, v2: v2 });

    if ((i + 1) % 25 === 0) {
      console.log(`  [${i+1}/${items.length}] gold ${goldCorrect}/${goldN}  v1 ${v1Accepted}/${v1N}  v2 ${v2Accepted}/${v2N}`);
    }
  }

  const outPath = args.input.replace(/\.json$/, ".rejudge.json");
  writeFileSync(outPath, JSON.stringify({
    judge_model: args.model,
    total: items.length,
    gold: { correct: goldCorrect, n: goldN, rate: goldN ? goldCorrect / goldN : 0 },
    v1_specific_wrong: { accepted: v1Accepted, n: v1N, rate: v1N ? v1Accepted / v1N : 0 },
    v2_vague_topical: { accepted: v2Accepted, n: v2N, rate: v2N ? v2Accepted / v2N : 0 },
    per_item: out,
  }, null, 2));

  console.log("");
  console.log("[rejudge] ---- SUMMARY ----");
  console.log(`  gold self-check:      ${goldCorrect}/${goldN} = ${(goldN?goldCorrect/goldN:0*100).toFixed(1)}%`);
  console.log(`  v1 specific-wrong:    ${v1Accepted}/${v1N} = ${(v1N?v1Accepted/v1N*100:0).toFixed(1)}%   (expect <10%)`);
  console.log(`  v2 vague-topical:     ${v2Accepted}/${v2N} = ${(v2N?v2Accepted/v2N*100:0).toFixed(1)}%   (expect <5%)`);
  console.log(`  saved: ${outPath}`);

  // Flag leniency
  if (v1N > 0 && v1Accepted / v1N > 0.10) console.log(`  ⚠ v1 acceptance > 10% — judge too lenient`);
  if (v2N > 0 && v2Accepted / v2N > 0.05) console.log(`  ⚠ v2 acceptance > 5% — judge too lenient`);
}

main().catch((e) => { console.error(e); process.exit(1); });
