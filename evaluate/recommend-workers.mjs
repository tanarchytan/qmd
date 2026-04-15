#!/usr/bin/env node
/**
 * recommend-workers.mjs — system-aware worker + microbatch recommender for
 * qmd evaluation runs. Detects CPU + RAM, applies a per-worker memory
 * budget, prints a recommendation per tier × mode.
 *
 * Existing precedents in this space (none cover tiered recommendations):
 *   - `nproc` / `sysctl -n hw.ncpu`              just core count
 *   - `make -j$(nproc)` / `cargo build -j`       single-tier auto-detect
 *   - Node `os.availableParallelism()` (>=v19)   cgroup-aware core count
 *   - Python `psutil.cpu_count() / virtual_memory()`   needs install
 *
 * This script is self-contained, zero deps, runs anywhere Node 19+ runs.
 *
 * Usage
 * -----
 *   # Human-readable table for all tiers + modes
 *   node evaluate/recommend-workers.mjs
 *
 *   # Machine-readable env vars for one tier+mode (eval $(...) friendly)
 *   node evaluate/recommend-workers.mjs --tier high --mode rerank
 *   # → WORKERS=4 MICROBATCH=64
 *
 *   # Pipe into a run command:
 *   eval $(node evaluate/recommend-workers.mjs --tier max --mode embed)
 *   QMD_EMBED_MICROBATCH=$MICROBATCH \
 *     npx tsx evaluate/longmemeval/eval.mts --ds s --limit 100 \
 *     --no-llm --workers $WORKERS
 *
 * Tiers
 * -----
 *   normal — conservative. Leaves 2 cores + 4GB RAM for the OS / other apps.
 *            Use on a shared dev machine while you're working in it.
 *   high   — aggressive. Leaves 1 core + 2GB. Use on a dedicated bench box
 *            you can hand over for the run.
 *   max    — everything. Reserves only 1GB RAM as headroom. Use on a dead
 *            VM where the run is the only workload.
 *
 * Modes
 * -----
 *   embed  — embed-only ingest path. mxbai-xs q8 working set ~2.5GB/worker.
 *   rerank — embed + cross-encoder rerank. Adds ~1.5GB/worker for the
 *            ms-marco-MiniLM cross-encoder model + activations.
 *
 * Per-worker memory estimates are empirical from the 2026-04-15 LME runs
 * on a 16-core / 60 GB Windows host. Override with --per-worker-gb N if
 * your model stack differs.
 *
 * Why cap at 8 workers
 * --------------------
 * SQLite WAL mode allows N concurrent readers but writers serialize. Past
 * 8 workers the eval harness's per-question DB writes start contending
 * faster than the embed path can amortize. 8 is the empirical knee on
 * mxbai-xs q8 + memoryStoreBatch.
 */

import os from "node:os";

const PER_WORKER_GB = {
  embed: 2.5,
  rerank: 4.0,
};

const TIERS = {
  normal: { cpuReserve: 2, ramReserveGb: 4, microbatch: 32 },
  high:   { cpuReserve: 1, ramReserveGb: 2, microbatch: 64 },
  max:    { cpuReserve: 0, ramReserveGb: 1, microbatch: 128 },
};

const MAX_WORKERS_SQLITE_KNEE = 8;

function detect() {
  const cores = os.availableParallelism?.() ?? os.cpus().length;
  const totalGb = os.totalmem() / 1024 ** 3;
  const freeGb = os.freemem() / 1024 ** 3;
  return { cores, totalGb, freeGb };
}

function recommend(tier, mode, sys, perWorkerOverride) {
  const t = TIERS[tier];
  if (!t) throw new Error(`unknown tier: ${tier}`);
  const perWorker = perWorkerOverride ?? PER_WORKER_GB[mode];
  if (perWorker == null) throw new Error(`unknown mode: ${mode}`);
  const usableCpus = Math.max(1, sys.cores - t.cpuReserve);
  const usableRamGb = Math.max(1, sys.freeGb - t.ramReserveGb);
  const ramBound = Math.floor(usableRamGb / perWorker);
  const workers = Math.max(1, Math.min(usableCpus, ramBound, MAX_WORKERS_SQLITE_KNEE));
  return { workers, microbatch: t.microbatch };
}

function parseArgs(argv) {
  const out = { tier: null, mode: null, perWorkerGb: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--tier" && argv[i + 1]) out.tier = argv[++i];
    else if (argv[i] === "--mode" && argv[i + 1]) out.mode = argv[++i];
    else if (argv[i] === "--per-worker-gb" && argv[i + 1]) out.perWorkerGb = parseFloat(argv[++i]);
    else if (argv[i] === "-h" || argv[i] === "--help") out.help = true;
  }
  return out;
}

function printHelp() {
  process.stdout.write(
    "Usage: node evaluate/recommend-workers.mjs [--tier normal|high|max] [--mode embed|rerank] [--per-worker-gb N]\n" +
    "Without --tier/--mode, prints a table for all combinations.\n" +
    "With both, prints `WORKERS=N MICROBATCH=M` for shell eval.\n"
  );
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return printHelp();
  const sys = detect();

  // Single recommendation mode — machine-readable env line.
  if (args.tier && args.mode) {
    const r = recommend(args.tier, args.mode, sys, args.perWorkerGb);
    process.stdout.write(`WORKERS=${r.workers} MICROBATCH=${r.microbatch}\n`);
    return;
  }

  // Default: human-readable table for all combinations.
  process.stdout.write(
    `System: ${sys.cores} cores, ${sys.totalGb.toFixed(1)} GB RAM (${sys.freeGb.toFixed(1)} GB free), platform=${os.platform()}\n\n` +
    `Recommended worker counts (--workers N + QMD_EMBED_MICROBATCH=M):\n\n` +
    `Tier   | Mode   | Workers | Microbatch | Notes\n` +
    `-------|--------|---------|------------|------\n`
  );
  for (const tier of ["normal", "high", "max"]) {
    for (const mode of ["embed", "rerank"]) {
      const r = recommend(tier, mode, sys, args.perWorkerGb);
      const t = TIERS[tier];
      const perWorker = args.perWorkerGb ?? PER_WORKER_GB[mode];
      const note = `${perWorker.toFixed(1)} GB/worker, reserve ${t.cpuReserve}c+${t.ramReserveGb}G`;
      process.stdout.write(
        `${tier.padEnd(6)} | ${mode.padEnd(6)} | ${String(r.workers).padEnd(7)} | ${String(r.microbatch).padEnd(10)} | ${note}\n`
      );
    }
  }
  process.stdout.write(
    `\nTo apply a recommendation:\n` +
    `  eval $(node evaluate/recommend-workers.mjs --tier high --mode rerank)\n` +
    `  QMD_EMBED_MICROBATCH=$MICROBATCH npx tsx evaluate/longmemeval/eval.mts \\\n` +
    `    --ds s --limit 100 --no-llm --workers $WORKERS\n`
  );
}

main();
