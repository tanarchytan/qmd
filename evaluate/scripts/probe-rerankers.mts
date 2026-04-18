#!/usr/bin/env node
// Phase 3 pre-flight: try to load each reranker candidate once.
// For each model: download + construct the backend + run a 2-doc rerank.
// Catches ONNX unavailable / arch-incompat / trust_remote_code issues BEFORE
// burning ~6 h on a full LME sweep that fails at model #5.
//
// Usage: node evaluate/scripts/probe-rerankers.mjs
// Exits 0 if all candidates load successfully; non-zero summarizes the failures.

import { createTransformersRerankBackend } from "../../src/llm/transformers-rerank.js";

const CANDIDATES = [
  { tag: "jina-tiny",            id: "jinaai/jina-reranker-v1-tiny-en" },
  { tag: "jina-turbo",           id: "jinaai/jina-reranker-v1-turbo-en" },
  { tag: "mxbai-xsmall",         id: "mixedbread-ai/mxbai-rerank-xsmall-v1" },
  { tag: "mxbai-base",           id: "mixedbread-ai/mxbai-rerank-base-v1" },
  { tag: "gte-modernbert",       id: "Alibaba-NLP/gte-reranker-modernbert-base" },
  { tag: "tomaarsen-modernbert", id: "tomaarsen/reranker-ModernBERT-base-gooaq-bce" },
];

const QUERY = "what is a cat";
const DOCS = [
  { file: "relevant",   text: "cats are small carnivorous mammals kept as household pets" },
  { file: "irrelevant", text: "the Treaty of Versailles was signed in 1919 ending World War I" },
];

const results = [];
for (const { tag, id } of CANDIDATES) {
  process.stderr.write(`\n[${tag}] ${id} — loading...\n`);
  const t0 = Date.now();
  try {
    const backend = await createTransformersRerankBackend(id);
    const { results: r } = await backend.rerank(QUERY, DOCS);
    const loadMs = Date.now() - t0;
    const relevant = r.find(x => x.file === "relevant");
    const irrelevant = r.find(x => x.file === "irrelevant");
    const gap = (relevant?.score ?? 0) - (irrelevant?.score ?? 0);
    const discriminates = gap > 1; // at least 1 logit unit of signal
    process.stderr.write(`  ✓ loaded in ${loadMs} ms, rel=${relevant?.score?.toFixed(2)} irr=${irrelevant?.score?.toFixed(2)} gap=${gap.toFixed(2)} ${discriminates ? "DISCRIMINATES" : "NO-SIGNAL"}\n`);
    results.push({ tag, id, status: discriminates ? "ok" : "no-signal", loadMs, gap });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`  ✗ ${msg}\n`);
    results.push({ tag, id, status: "fail", error: msg.slice(0, 200) });
  }
}

console.log("\n" + "=".repeat(80));
console.log("Reranker pre-flight summary");
console.log("=".repeat(80));
console.log(`${"tag".padEnd(22)} ${"status".padEnd(12)} ${"loadMs".padStart(8)} ${"gap".padStart(8)}  notes`);
console.log("-".repeat(80));
for (const r of results) {
  const notes = r.status === "fail" ? r.error : "";
  console.log(`${r.tag.padEnd(22)} ${r.status.padEnd(12)} ${String(r.loadMs ?? "—").padStart(8)} ${(r.gap != null ? r.gap.toFixed(2) : "—").padStart(8)}  ${notes}`);
}

const fails = results.filter(r => r.status === "fail");
const noSignal = results.filter(r => r.status === "no-signal");
if (fails.length > 0) {
  console.error(`\n${fails.length}/${CANDIDATES.length} failed to load — fix or drop from Phase 3 config before running sweep.`);
  process.exit(1);
}
if (noSignal.length > 0) {
  console.error(`\n${noSignal.length}/${CANDIDATES.length} load but don't discriminate — check model tokenizer config, likely wrong pooling or output head.`);
  process.exit(2);
}
console.log(`\nAll ${CANDIDATES.length} candidates load and discriminate. Phase 3 sweep is safe to run.`);
