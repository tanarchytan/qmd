#!/usr/bin/env node
/**
 * Phase 6 sweep ranking — picks winners across the 4 Phase 6 sweeps.
 *
 * Reads SUMMARY.md-sibling JSONs from each sweep dir, pulls R@5/MRR/NDCG@10,
 * ranks each sweep, and prints a combined leaderboard. Run after the
 * phase6-queue finishes all four sweeps.
 *
 * Usage:
 *   node evaluate/scripts/summarize-phase6.mjs                    # auto-detect today's dirs
 *   node evaluate/scripts/summarize-phase6.mjs <sweep-dir>...     # explicit list
 *
 * Output: markdown table per sweep + single "best config per lever" summary.
 */

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";

const SWEEP_NAMES = [
  "max-chars-phase6-lme",
  "mmr-kpool-phase6-lme",
  "rerank-blend-phase6-lme",
  "expand-syn-phase6-lme",
];

function findLatestSweepDir(prefix) {
  const sweepsRoot = "evaluate/sweeps";
  if (!existsSync(sweepsRoot)) return null;
  const matches = readdirSync(sweepsRoot)
    .filter((d) => d.startsWith(prefix + "-"))
    .map((d) => ({ dir: join(sweepsRoot, d), mtime: statSync(join(sweepsRoot, d)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return matches[0]?.dir ?? null;
}

function readConfigResults(sweepDir) {
  if (!sweepDir || !existsSync(sweepDir)) return [];
  const configs = readdirSync(sweepDir).filter((d) => {
    const p = join(sweepDir, d);
    return statSync(p).isDirectory() && existsSync(join(p, "lme.json"));
  });
  const rows = [];
  for (const tag of configs) {
    const lmePath = join(sweepDir, tag, "lme.json");
    let d;
    try { d = JSON.parse(readFileSync(lmePath, "utf8")); } catch { continue; }
    const s = d.summary ?? d;
    if (!s) continue;
    // LME summary keys — may differ between LME vs LoCoMo
    const rAny5 = s.rAny5 ?? s.recall_any_at_5 ?? s.recallAny5;
    const R5 = s.R5 ?? s.recall_at_5 ?? s.recall5 ?? s.avgR5;
    const MRR = s.MRR ?? s.mrr ?? s.avgMRR;
    const NDCG10 = s.NDCG10 ?? s.ndcg_at_10 ?? s.ndcg10;
    const F1 = s.F1 ?? s.f1 ?? s.avgF1;
    const partial = d.partial === true;
    rows.push({ tag, rAny5, R5, MRR, NDCG10, F1, partial });
  }
  return rows;
}

function fmt(n, digits = 3) {
  if (n === undefined || n === null || Number.isNaN(n)) return "—";
  return typeof n === "number" ? n.toFixed(digits) : String(n);
}

function rankBy(rows, key, desc = true) {
  return [...rows]
    .filter((r) => typeof r[key] === "number" && !Number.isNaN(r[key]))
    .sort((a, b) => desc ? b[key] - a[key] : a[key] - b[key]);
}

const explicitDirs = process.argv.slice(2);
const sweepPaths = explicitDirs.length > 0
  ? explicitDirs
  : SWEEP_NAMES.map(findLatestSweepDir).filter(Boolean);

if (sweepPaths.length === 0) {
  console.error("No sweep dirs found. Usage: summarize-phase6.mjs [sweep-dir ...]");
  console.error("Looked for prefixes:", SWEEP_NAMES.join(", "));
  process.exit(1);
}

const bestPerSweep = [];
console.log("# Phase 6 sweep leaderboard\n");
for (const dir of sweepPaths) {
  const rows = readConfigResults(dir);
  if (rows.length === 0) {
    console.log(`## ${dir}\n\n  (no results found)\n`);
    continue;
  }
  const rankedMRR = rankBy(rows, "MRR");
  const rankedR5 = rankBy(rows, "R5");
  console.log(`## ${dir}\n`);
  console.log("| tag | rAny@5 | R@5 | MRR | NDCG@10 | F1 |");
  console.log("|-----|--------|-----|-----|---------|-----|");
  for (const r of rows) {
    const marker = rankedMRR[0]?.tag === r.tag ? "**" : "";
    console.log(`| ${marker}${r.tag}${marker} | ${fmt(r.rAny5, 3)} | ${fmt(r.R5, 3)} | ${fmt(r.MRR, 3)} | ${fmt(r.NDCG10, 3)} | ${fmt(r.F1, 3)} |${r.partial ? " (PARTIAL)" : ""}`);
  }
  console.log("");
  if (rankedMRR[0]) {
    bestPerSweep.push({
      sweep: dir.split(/[/\\]/).pop(),
      mrr_winner: rankedMRR[0],
      r5_winner: rankedR5[0],
    });
  }
}

if (bestPerSweep.length > 0) {
  console.log("## Winners per lever\n");
  console.log("| Sweep | Best by MRR (tag / score) | Best by R@5 (tag / score) |");
  console.log("|-------|---------------------------|---------------------------|");
  for (const w of bestPerSweep) {
    console.log(`| ${w.sweep} | ${w.mrr_winner.tag} / ${fmt(w.mrr_winner.MRR, 3)} | ${w.r5_winner?.tag ?? "—"} / ${fmt(w.r5_winner?.R5, 3)} |`);
  }
  console.log("\nCompose combined-winners stack (#38) from these per-lever picks.");
}
