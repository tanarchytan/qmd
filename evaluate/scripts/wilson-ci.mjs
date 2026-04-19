#!/usr/bin/env node
/**
 * Wilson Score 95% CI analysis of Lotl eval results.
 *
 * Ports the stdlib-only stats logic from dial481/locomo-audit
 * (results-audit/statistical_validity.py) into Node so it can chain with
 * our JSON-first toolchain. Pure math, no deps.
 *
 * Usage:
 *   node evaluate/scripts/wilson-ci.mjs <results-json> [<results-json>...]
 *   node evaluate/scripts/wilson-ci.mjs --compare <a.json> <b.json>
 *
 * Emits a table with per-category (or per-question-type) judge accuracy
 * plus 95% Wilson CIs. With --compare, adds distinguishability flags
 * (✓ if CIs don't overlap, ~ if marginal, ✗ if indistinguishable).
 */

import { readFileSync } from "node:fs";

const Z = 1.96; // 95%

/**
 * Wilson Score 95% CI for binomial proportion.
 * Returns {lower, upper, width, center} as proportions [0,1].
 * More accurate than Wald on small n or extreme p, which is the regime
 * that bites us on per-question-type slices (LME open-domain n=96).
 */
function wilsonCI(n, k) {
  if (n === 0) return { lower: 0, upper: 0, width: 0, center: 0 };
  const p = k / n;
  const denom = 1 + (Z * Z) / n;
  const center = (p + (Z * Z) / (2 * n)) / denom;
  const spread = Z * Math.sqrt((p * (1 - p) + (Z * Z) / (4 * n)) / n) / denom;
  const lower = Math.max(0, center - spread);
  const upper = Math.min(1, center + spread);
  return { lower, upper, width: upper - lower, center };
}

/** LME results → {all, by_type: {type: {n, k}}}. */
function summarizeLME(data) {
  const results = data.results || [];
  const byType = {};
  let n = 0, k = 0;
  for (const r of results) {
    if (r.judgeCorrect == null) continue;
    n++;
    if (r.judgeCorrect === 1) k++;
    const t = r.question_type || "unknown";
    if (!byType[t]) byType[t] = { n: 0, k: 0 };
    byType[t].n++;
    if (r.judgeCorrect === 1) byType[t].k++;
  }
  return { overall: { n, k }, byBucket: byType };
}

/** LoCoMo results → {all, by_category: {category: {n, k}}}. */
function summarizeLoCoMo(data) {
  const results = data.results || [];
  const byCat = {};
  let n = 0, k = 0;
  for (const r of results) {
    const v = r.judge;
    if (v == null) continue;
    n++;
    if (v === 1) k++;
    const c = r.categoryName || String(r.category || "unknown");
    if (!byCat[c]) byCat[c] = { n: 0, k: 0 };
    byCat[c].n++;
    if (v === 1) byCat[c].k++;
  }
  return { overall: { n, k }, byBucket: byCat };
}

function summarize(path) {
  const data = JSON.parse(readFileSync(path, "utf8"));
  // Detect benchmark by field layout.
  const isLME = data.results?.[0]?.judgeCorrect !== undefined;
  const s = isLME ? summarizeLME(data) : summarizeLoCoMo(data);
  return { path, bench: isLME ? "LME" : "LoCoMo", ...s };
}

function fmt(s) {
  const ci = wilsonCI(s.n, s.k);
  const pct = s.n > 0 ? ((s.k / s.n) * 100).toFixed(1) : "-";
  return {
    n: s.n,
    k: s.k,
    pct,
    lo: (ci.lower * 100).toFixed(1),
    hi: (ci.upper * 100).toFixed(1),
    width: (ci.width * 100).toFixed(1),
  };
}

function printTable(label, overall, byBucket) {
  console.log(`\n${"=".repeat(68)}`);
  console.log(`  ${label}`);
  console.log("=".repeat(68));
  const rows = [{ name: "overall", ...fmt(overall) }];
  for (const [name, s] of Object.entries(byBucket).sort((a, b) => b[1].n - a[1].n)) {
    rows.push({ name, ...fmt(s) });
  }
  console.log("| category       |   n |   k | judge% |    95% CI      | width |");
  console.log("|----------------|-----|-----|--------|----------------|-------|");
  for (const r of rows) {
    console.log(`| ${r.name.padEnd(14)} | ${String(r.n).padStart(3)} | ${String(r.k).padStart(3)} | ${r.pct.padStart(5)}% | ${r.lo.padStart(5)}% – ${r.hi.padStart(5)}% | ${r.width.padStart(4)}pp |`);
  }
}

function distinguishable(a, b) {
  const ciA = wilsonCI(a.n, a.k);
  const ciB = wilsonCI(b.n, b.k);
  // Non-overlap → distinguishable at 95%. Overlap → not.
  if (ciA.upper < ciB.lower || ciB.upper < ciA.lower) return "✓";
  // Marginal: CIs overlap but point estimates separated by > half the larger CI width.
  const sepPct = Math.abs(ciA.center - ciB.center) * 100;
  const maxHalfWidth = Math.max(ciA.width, ciB.width) * 50;
  if (sepPct > maxHalfWidth) return "~";
  return "✗";
}

function printCompare(a, b) {
  console.log(`\n${"=".repeat(68)}`);
  console.log(`  Distinguishability: ${a.path.split(/[/\\]/).pop()} vs ${b.path.split(/[/\\]/).pop()}`);
  console.log("=".repeat(68));
  console.log("| bucket         | A (n/k/%)      | B (n/k/%)      | Δpp   | distinguishable |");
  console.log("|----------------|----------------|----------------|-------|-----------------|");
  const names = new Set([...Object.keys(a.byBucket), ...Object.keys(b.byBucket), "overall"]);
  for (const name of names) {
    const sa = name === "overall" ? a.overall : a.byBucket[name];
    const sb = name === "overall" ? b.overall : b.byBucket[name];
    if (!sa || !sb) continue;
    const fa = fmt(sa), fb = fmt(sb);
    const delta = (Number(fb.pct) - Number(fa.pct)).toFixed(1);
    const dist = distinguishable(sa, sb);
    console.log(`| ${name.padEnd(14)} | ${String(sa.n).padStart(3)}/${String(sa.k).padStart(3)}/${fa.pct.padStart(5)}% | ${String(sb.n).padStart(3)}/${String(sb.k).padStart(3)}/${fb.pct.padStart(5)}% | ${delta.padStart(5)} |       ${dist}         |`);
  }
  console.log("\n  ✓ = CIs non-overlapping at 95% (genuine difference)");
  console.log("  ~ = CIs overlap but point separation > max(half-width) (marginal)");
  console.log("  ✗ = CIs overlap significantly (statistically indistinguishable)");
}

const args = process.argv.slice(2);
if (args[0] === "--compare") {
  if (args.length !== 3) {
    console.error("usage: --compare <a.json> <b.json>");
    process.exit(2);
  }
  const a = summarize(args[1]);
  const b = summarize(args[2]);
  printTable(`A: ${args[1]}`, a.overall, a.byBucket);
  printTable(`B: ${args[2]}`, b.overall, b.byBucket);
  printCompare(a, b);
} else {
  if (args.length === 0) {
    console.error("usage: wilson-ci.mjs <results-json> [...] | --compare <a> <b>");
    process.exit(2);
  }
  for (const p of args) {
    const s = summarize(p);
    printTable(`${s.bench}: ${p}`, s.overall, s.byBucket);
  }
}
