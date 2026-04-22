#!/usr/bin/env node
// summarize-sweep.mjs — read all lme.json/locomo.json under a sweep dir and
// print a markdown diff table ranked by MRR, with deltas vs the first row
// (conventionally `baseline`).
//
// Usage: node evaluate/scripts/summarize-sweep.mjs <sweep-dir>

import { readFileSync, readdirSync, statSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const sweepDir = process.argv[2];
if (!sweepDir) {
  console.error("Usage: summarize-sweep.mjs <sweep-dir>");
  process.exit(2);
}

// Each immediate subdir is one config run.
const tags = readdirSync(sweepDir)
  .filter(n => statSync(join(sweepDir, n)).isDirectory())
  .sort((a, b) => (a === "baseline" ? -1 : b === "baseline" ? 1 : a.localeCompare(b)));

const pct = v => (v == null ? "—" : (v * 100).toFixed(1) + "%");
const f3 = v => (v == null ? "—" : v.toFixed(3));
const secs = s => (s == null ? "—" : s + "s");

function loadRun(tag) {
  const dir = join(sweepDir, tag);
  const lmePath = join(dir, "lme.json");
  const locomoPath = join(dir, "locomo.json");
  const overlayPath = join(dir, "overlay");
  const lmeWallPath = join(dir, "lme.wall");
  const locomoWallPath = join(dir, "locomo.wall");

  const lme = existsSync(lmePath) ? JSON.parse(readFileSync(lmePath, "utf8")).summary : null;
  const locomo = existsSync(locomoPath) ? JSON.parse(readFileSync(locomoPath, "utf8")).summary : null;
  const overlay = existsSync(overlayPath) ? readFileSync(overlayPath, "utf8").trim() : "";
  const lmeWall = existsSync(lmeWallPath) ? parseInt(readFileSync(lmeWallPath, "utf8").trim(), 10) : null;
  const locomoWall = existsSync(locomoWallPath) ? parseInt(readFileSync(locomoWallPath, "utf8").trim(), 10) : null;

  return { tag, overlay, lme, locomo, lmeWall, locomoWall };
}

const runs = tags.map(loadRun);
const baseline = runs.find(r => r.tag === "baseline") || runs[0];
if (!baseline) {
  console.error(`No runs found in ${sweepDir}`);
  process.exit(1);
}

function fmtDelta(v, base) {
  if (v == null || base == null) return "";
  const d = (v - base) * 100;
  if (Math.abs(d) < 0.05) return " (±0.0)";
  const sign = d > 0 ? "+" : "";
  return ` (${sign}${d.toFixed(1)})`;
}

function renderCorpus(corpusName, getter, wallKey) {
  const header = `## ${corpusName}`;
  const cols = ["tag", "rAny@5", "R@5", "MRR", "NDCG@10", "Cov@5", "wall", "overlay"];
  const lines = [header, "", `| ${cols.join(" | ")} |`, `| ${cols.map(() => "---").join(" | ")} |`];
  const base = getter(baseline);
  for (const run of runs) {
    const s = getter(run);
    if (!s) { lines.push(`| ${run.tag} | — | — | — | — | — | — | ${run.overlay || ""} |`); continue; }
    const row = [
      run.tag,
      pct(s.avgRAny5) + fmtDelta(s.avgRAny5, base?.avgRAny5),
      pct(s.avgR5) + fmtDelta(s.avgR5, base?.avgR5),
      f3(s.avgMRR) + (base && s.avgMRR != null && base.avgMRR != null
        ? ` (${(s.avgMRR - base.avgMRR >= 0 ? "+" : "")}${(s.avgMRR - base.avgMRR).toFixed(3)})`
        : ""),
      f3(s.avgNDCG10),
      pct(s.avgCovR5),
      secs(run[wallKey]),
      run.overlay || "",
    ];
    lines.push(`| ${row.join(" | ")} |`);
  }
  return lines.join("\n");
}

const anyLme = runs.some(r => r.lme);
const anyLocomo = runs.some(r => r.locomo);

let md = `# Sweep summary: ${sweepDir.split(/[\\/]/).pop()}\n\n`;
md += `Runs: ${runs.length}. Baseline row: **${baseline.tag}**. Deltas in () are pp (percentage points) vs baseline.\n`;

if (anyLme) md += "\n" + renderCorpus("LongMemEval (n=500)", r => r.lme, "lmeWall") + "\n";
if (anyLocomo) md += "\n" + renderCorpus("LoCoMo (10 convs)", r => r.locomo, "locomoWall") + "\n";

console.log(md);
writeFileSync(join(sweepDir, "SUMMARY.md"), md);
console.log(`\nSaved: ${join(sweepDir, "SUMMARY.md")}`);
