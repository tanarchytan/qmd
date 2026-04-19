#!/usr/bin/env node
/**
 * Audit Lotl LoCoMo eval results against dial481/locomo-audit's errors.json.
 *
 * For each scoring error identified by the audit (156 total, 99 score-corrupting,
 * 57 wrong-citation-only), check how our system answered:
 *  - Questions we marked WRONG that the audit says have bad goldens →
 *    potentially correct-but-penalized.
 *  - Questions we marked CORRECT that still match the (possibly-corrected)
 *    answer → no change.
 *
 * Reports:
 *  1. Per-error-type breakdown of our verdict distribution.
 *  2. "Theoretical ceiling" score if we rescored against corrected goldens.
 *  3. List of specific questions where the audit helps us.
 *
 * Usage:
 *   node evaluate/scripts/audit-locomo-goldens.mjs <our-results.json> [<errors.json>]
 *
 * Default audit file path: <repo>/../locomo-audit-analysis/repo/errors.json
 * (standard clone location from earlier session probe).
 */

import { readFileSync } from "node:fs";
import { existsSync } from "node:fs";

const args = process.argv.slice(2);
const resultsPath = args[0];
const AUDIT_PATH_CANDIDATES = [
  args[1],
  "C:/Users/DAVIDG~1/AppData/Local/Temp/locomo-audit-analysis/repo/errors.json",
  "/tmp/locomo-audit-analysis/repo/errors.json",
  "./locomo-audit-analysis/repo/errors.json",
].filter(Boolean);
const auditPath = AUDIT_PATH_CANDIDATES.find((p) => p && existsSync(p));

if (!resultsPath || !auditPath) {
  console.error("usage: audit-locomo-goldens.mjs <our-results.json> [<errors.json>]");
  console.error("auditPath candidates:", AUDIT_PATH_CANDIDATES);
  process.exit(2);
}

const results = JSON.parse(readFileSync(resultsPath, "utf8"));
const errors = JSON.parse(readFileSync(auditPath, "utf8"));

// Index our results by {sample_id}-qa{idx}. LoCoMo audit format:
// "locomo_<sample_id>_qa<N>" where N is 1-indexed. Our sample_id comes from
// conv JSON; our question index is 0-indexed in results.
// We build both keyings and match either.
function ourKeys(r, idx) {
  const sid = r.sample_id || "unknown";
  const qIdx = r.qa_idx ?? idx;
  return [
    `${sid}-qa${qIdx}`,
    `${sid}-q${qIdx}`,
    `locomo_${sid}_qa${qIdx + 1}`,
    `locomo_${sid}_qa${qIdx}`,
  ];
}

// Flatten + index our results
const ourByQid = new Map();
(results.results || []).forEach((r, idx) => {
  for (const k of ourKeys(r, idx)) ourByQid.set(k, r);
});

// Also key by normalized question text (fallback if IDs don't line up)
const ourByQuestion = new Map();
for (const r of results.results || []) {
  const qnorm = (r.question || "").toLowerCase().replace(/[^a-z0-9 ]/g, "").trim().slice(0, 80);
  if (qnorm) ourByQuestion.set(qnorm, r);
}

// Cross-reference
let matched = 0;
let unmatched = 0;
const typeBreakdown = {};
const opportunities = []; // questions where we lost but audit says gold is wrong

for (const err of errors) {
  let our = ourByQid.get(err.question_id);
  if (!our) {
    const qnorm = (err.question || "").toLowerCase().replace(/[^a-z0-9 ]/g, "").trim().slice(0, 80);
    our = ourByQuestion.get(qnorm);
  }
  if (!our) { unmatched++; continue; }
  matched++;

  const t = err.error_type;
  if (!typeBreakdown[t]) typeBreakdown[t] = { wrong: 0, correct: 0, null: 0 };
  const verdict = our.judge;
  if (verdict === 1) typeBreakdown[t].correct++;
  else if (verdict === 0) {
    typeBreakdown[t].wrong++;
    if (err.error_type !== "WRONG_CITATION") {
      // Score-corrupting error — our WRONG may actually be right
      opportunities.push({
        qid: err.question_id,
        type: err.error_type,
        question: err.question,
        ourPrediction: (our.prediction || "").slice(0, 100),
        auditGold: err.golden_answer,
        auditCorrected: err.correct_answer,
        ourF1: our.f1,
      });
    }
  } else typeBreakdown[t].null++;
}

// Overall summary
const n = (results.results || []).length;
const judged = (results.results || []).filter((r) => r.judge != null).length;
const correct = (results.results || []).filter((r) => r.judge === 1).length;
const currentAcc = judged > 0 ? (correct / judged) * 100 : 0;

// Theoretical ceiling: if we'd gotten all score-corrupting errored-gold ones right
const scoringFixable = opportunities.length;
const ceilingAcc = judged > 0 ? ((correct + scoringFixable) / judged) * 100 : 0;

console.log("=".repeat(72));
console.log(`  Audit cross-ref: ${resultsPath}`);
console.log(`  vs errors.json:  ${auditPath}`);
console.log("=".repeat(72));
console.log(`  Total questions:     ${n}`);
console.log(`  Judged (non-null):   ${judged}`);
console.log(`  Current accuracy:    ${correct}/${judged} = ${currentAcc.toFixed(1)}%`);
console.log();
console.log(`  Audit errors:            ${errors.length}`);
console.log(`    matched to our run:    ${matched}`);
console.log(`    unmatched (skipped):   ${unmatched}`);
console.log();
console.log("  Per-error-type verdict breakdown (from our run):");
for (const [t, bd] of Object.entries(typeBreakdown)) {
  console.log(`    ${t.padEnd(20)} wrong=${String(bd.wrong).padStart(3)} correct=${String(bd.correct).padStart(3)} null=${String(bd.null).padStart(3)}`);
}
console.log();
console.log(`  Score-corrupting opportunities: ${scoringFixable}`);
console.log(`    (our WRONG verdicts on questions where audit says gold was bad)`);
console.log();
console.log(`  Theoretical ceiling if all corrected: ${(correct + scoringFixable)}/${judged} = ${ceilingAcc.toFixed(1)}% (+${(ceilingAcc - currentAcc).toFixed(1)}pp)`);
console.log();
if (opportunities.length) {
  console.log("  Top 5 opportunities:");
  for (const o of opportunities.slice(0, 5)) {
    console.log(`    [${o.type}] ${o.qid}`);
    console.log(`      Q: ${o.question?.slice(0, 80)}`);
    console.log(`      our pred:   ${JSON.stringify(o.ourPrediction)}`);
    console.log(`      audit gold: ${JSON.stringify(o.auditGold)}`);
    console.log(`      corrected:  ${JSON.stringify(o.auditCorrected)}`);
  }
  console.log();
  if (opportunities.length > 5) console.log(`    ... ${opportunities.length - 5} more`);
}
