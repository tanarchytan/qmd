/**
 * Merge sharded LongMemEval results into a single aggregated report.
 *
 * Usage:
 *   npx tsx evaluate/longmemeval/merge-shards.mts --tag mytest --shards 4
 *
 * Reads:    results-mytest-shard{0..N-1}.json
 * Writes:   results-mytest.json (merged)
 */

import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

const args = process.argv.slice(2);
let tag = "";
let shards = 0;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--tag" && args[i + 1]) tag = args[i + 1]!;
  if (args[i] === "--shards" && args[i + 1]) shards = parseInt(args[i + 1]!, 10);
}
if (!tag || !shards) {
  console.error("Usage: merge-shards.mts --tag <tag> --shards <N>");
  process.exit(1);
}

const baseDir = join(process.cwd(), "evaluate/longmemeval");
const allResults: any[] = [];
let firstConfig: any = null;
for (let i = 0; i < shards; i++) {
  const path = join(baseDir, `results-${tag}-shard${i}.json`);
  try {
    const r = JSON.parse(readFileSync(path, "utf-8"));
    if (!firstConfig) firstConfig = r.config;
    allResults.push(...r.results);
  } catch (e) {
    console.error(`Failed to read ${path}:`, e);
    process.exit(1);
  }
}

const n = allResults.length;
const sum = (k: string) => allResults.reduce((s, r) => s + (r[k] || 0), 0);
const summary = {
  avgR5: sum("r5") / n,
  avgR10: sum("r10") / n,
  avgF1: sum("f1") / n,
  avgEM: sum("em") / n,
  total: n,
};

console.log(`Merged ${n} questions from ${shards} shards`);
console.log(`R@5:  ${(summary.avgR5 * 100).toFixed(1)}%`);
console.log(`R@10: ${(summary.avgR10 * 100).toFixed(1)}%`);
console.log(`F1:   ${(summary.avgF1 * 100).toFixed(1)}%`);
console.log(`EM:   ${(summary.avgEM * 100).toFixed(1)}%`);

console.log(`\nBy question type:`);
const types = [...new Set(allResults.map(r => r.question_type))].sort();
for (const qt of types) {
  const qrs = allResults.filter(r => r.question_type === qt);
  const f1 = qrs.reduce((s, r) => s + r.f1, 0) / qrs.length;
  const em = qrs.reduce((s, r) => s + r.em, 0) / qrs.length;
  console.log(`  ${qt.padEnd(30)} (n=${String(qrs.length).padStart(4)}): F1=${(f1 * 100).toFixed(1).padStart(5)}%  EM=${(em * 100).toFixed(1).padStart(5)}%`);
}

const outPath = join(baseDir, `results-${tag}.json`);
writeFileSync(outPath, JSON.stringify({
  config: firstConfig,
  summary,
  results: allResults,
}, null, 2));
console.log(`\nSaved merged: ${outPath}`);
