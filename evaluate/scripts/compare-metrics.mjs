#!/usr/bin/env node
// compare-metrics.mjs — strict byte-identical parity check across two result JSONs.
// Used by the worker-bump smoke to ensure concurrency changes don't introduce
// a race condition that silently changes retrieval output.
//
// Usage: node compare-metrics.mjs <a.json> <b.json>
// Exits 0 on match, 1 on mismatch.

import { readFileSync } from "node:fs";

const [aPath, bPath] = process.argv.slice(2);
if (!aPath || !bPath) {
  console.error("Usage: compare-metrics.mjs <a.json> <b.json>");
  process.exit(2);
}

const a = JSON.parse(readFileSync(aPath, "utf8"));
const b = JSON.parse(readFileSync(bPath, "utf8"));

// Metrics we care about for parity. Float compare with tight epsilon —
// determinism across worker-count changes should produce bit-identical scores
// given the seeded LLM cache + deterministic retrieval.
const FIELDS = [
  "avgRAny5", "avgRAny10", "avgRAny20",
  "avgR5", "avgR10", "avgR20",
  "avgMRR", "avgNDCG10",
  "avgCovR5", "avgCovR10",
];

const EPS = 1e-9;
let mismatches = 0;

console.log(`\n${"metric".padEnd(14)} ${"a".padStart(10)} ${"b".padStart(10)} ${"diff".padStart(12)}`);
console.log("-".repeat(50));
for (const f of FIELDS) {
  const va = a.summary?.[f];
  const vb = b.summary?.[f];
  if (va === undefined || vb === undefined) continue;
  const d = Math.abs(va - vb);
  const bad = d > EPS;
  if (bad) mismatches++;
  const mark = bad ? " ✗" : " ✓";
  console.log(
    `${f.padEnd(14)} ${va.toFixed(6).padStart(10)} ${vb.toFixed(6).padStart(10)} ${d.toExponential(2).padStart(12)}${mark}`,
  );
}

if (mismatches > 0) {
  console.log(`\nFAIL — ${mismatches} metrics diverged. Concurrency change introduced non-determinism.`);
  process.exit(1);
}
console.log("\nPASS — metrics byte-identical within ε=1e-9");
