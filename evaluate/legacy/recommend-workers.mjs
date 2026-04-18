#!/usr/bin/env node
/**
 * recommend-workers.mjs — system-aware worker + microbatch recommender for
 * qmd evaluation runs. Detects CPU + RAM, applies a per-worker memory
 * budget, prints a recommendation per tier × mode. Auto-picks the right
 * tier when none is specified.
 *
 * Existing precedents (none cover tiered recommendations):
 *   - `nproc` / `sysctl -n hw.ncpu`              just core count
 *   - `make -j$(nproc)` / `cargo build -j`       single-tier auto-detect
 *   - Node `os.availableParallelism()` (>=v19)   cgroup-aware core count
 *   - Python `psutil.cpu_count() / virtual_memory()`   needs install
 *
 * Self-contained, zero deps, runs anywhere Node 19+ runs.
 *
 * Usage
 * -----
 *   # Auto-pick tier based on system specs (no flags)
 *   node evaluate/recommend-workers.mjs
 *
 *   # Force a specific tier
 *   node evaluate/recommend-workers.mjs --tier high
 *
 *   # Single-line env vars for shell eval
 *   eval $(node evaluate/recommend-workers.mjs --mode rerank)
 *   QMD_EMBED_MICROBATCH=$MICROBATCH \
 *     npx tsx evaluate/longmemeval/eval.mts --ds s --limit 100 \
 *     --no-llm --workers $WORKERS
 *
 * Tiers — defined by user-visible impact, not raw resource fraction
 * ------------------------------------------------------------------
 *   low    — system feels untouched. Reserve 75% of cores + 75% of free
 *            RAM. Use while you're actively working in the same machine.
 *   normal — minor slowdown, browser still snappy. Reserve 50% / 50%.
 *            Default for most dev machines.
 *   high   — system noticeably slow but responsive. Reserve 25% / 25%.
 *            Use when you can step away for the run duration.
 *   max    — system unresponsive — "everything else is unusable but the
 *            run still completes." Reserves only 1 core + 1 GB safety
 *            headroom. Use on a dedicated bench box or VM.
 *
 * Modes
 * -----
 *   embed  — embed-only ingest (mxbai-xs q8). ~2.5 GB/worker.
 *   rerank — embed + cross-encoder rerank (ms-marco-MiniLM q8). ~4 GB/worker.
 *
 * Auto-tier selection (when no --tier is passed)
 * ----------------------------------------------
 *   cores >= 12 && free RAM >= 24 GB  → high
 *   cores >=  6 && free RAM >= 12 GB  → normal
 *   otherwise                          → low
 *
 * `max` is never auto-selected — it has to be explicit because it makes
 * the host unusable for anything else.
 *
 * Why cap at 8 workers
 * --------------------
 * SQLite WAL writers serialize. Past 8 workers the eval harness's per-
 * question DB writes contend faster than the embed path amortizes. 8 is
 * the empirical knee on mxbai-xs q8 + memoryStoreBatch.
 */

import os from "node:os";

const PER_WORKER_GB = {
  embed: 2.5,
  rerank: 4.0,
};

// Tiers expressed as fractions of the SYSTEM, not absolute numbers, so
// they scale across small laptops and big bench boxes uniformly.
//   cpuReserveFrac — fraction of cores left for the OS / other apps
//   ramReserveFrac — fraction of free RAM left as headroom
//   absMinCpuReserve — additional floor on cpu reservation (small boxes)
//   absMinRamGb     — additional floor on ram reservation (small boxes)
//   microbatch      — embed micro-batch size (RAM-correlated)
const TIERS = {
  low:    { cpuReserveFrac: 0.75, ramReserveFrac: 0.75, absMinCpuReserve: 2, absMinRamGb: 4, microbatch: 16 },
  normal: { cpuReserveFrac: 0.50, ramReserveFrac: 0.50, absMinCpuReserve: 2, absMinRamGb: 4, microbatch: 32 },
  high:   { cpuReserveFrac: 0.25, ramReserveFrac: 0.25, absMinCpuReserve: 1, absMinRamGb: 2, microbatch: 64 },
  max:    { cpuReserveFrac: 0.00, ramReserveFrac: 0.00, absMinCpuReserve: 1, absMinRamGb: 1, microbatch: 128 },
};

// Empirical knee on a 16-core / 60 GB Windows host with mxbai-xs q8 +
// memoryStoreBatch (LME n=100, 2026-04-15 sweep):
//
//   workers | wall (1 sample) | notes
//   --------|----------------|--------------------------------------
//   2       | 2m56s          | clean baseline, no contention
//   4       | 3m21s          | valley — contention starts, no overlap
//   5       | 3m22s          | valley peak
//   6       | 3m10s          | recovering
//   7       | 3m10s          | "
//   8       | 2m49s, 3m13s   | best on average, ±13% run-to-run variance
//
// Two takeaways:
//   1. Embed forward pass is single-thread WASM. Workers don't add CPU
//      throughput; they only overlap IO/JSON/SQL with each other's CPU
//      stalls. Past ~6 workers the overlap dominates, below ~3 there's
//      neither contention nor enough overlap, and 4-5 is the worst spot.
//   2. The "best" workers=8 wall has high variance (~13% run-to-run).
//      Don't trust a single sample as definitive. workers=2 is the
//      lowest-variance pick if predictability matters more than peak.
//
// Cap is mode-dependent because cross-encoder rerank doesn't scale the
// same way as embed-only.
//
//   embed-only path:  workers ≈ 8 wins on average (with ±13% variance)
//                     because embed forward pass is single-thread WASM
//                     but the JS event loop overlaps IO/SQL between
//                     workers' CPU stalls.
//
//   rerank path:      workers ≈ 2 wins (cerank w=2 = 3m04s, cerank w=8
//                     = 3m51s on the same host). Cross-encoder forward
//                     pass is ALSO single-thread WASM and 8 concurrent
//                     queries fight for the same WASM heap — contention
//                     adds ~50 s/run with no offsetting overlap because
//                     the cerank pass dominates per-query wall.
//
// Smaller hosts may peak earlier on either path — verify with the
// sweep harness before relying on the caps.
const MAX_WORKERS_KNEE = {
  embed:  8,
  rerank: 2,
};

function detect() {
  const cores = os.availableParallelism?.() ?? os.cpus().length;
  const totalGb = os.totalmem() / 1024 ** 3;
  const freeGb = os.freemem() / 1024 ** 3;
  return { cores, totalGb, freeGb };
}

// Auto-pick a tier given the system. `max` is never auto — it has to be
// explicitly requested because it makes the host unusable.
function autoTier(sys) {
  if (sys.cores >= 12 && sys.freeGb >= 24) return "high";
  if (sys.cores >= 6 && sys.freeGb >= 12) return "normal";
  return "low";
}

function recommend(tier, mode, sys, perWorkerOverride) {
  const t = TIERS[tier];
  if (!t) throw new Error(`unknown tier: ${tier} (use low|normal|high|max)`);
  const perWorker = perWorkerOverride ?? PER_WORKER_GB[mode];
  if (perWorker == null) throw new Error(`unknown mode: ${mode} (use embed|rerank)`);

  const cpuReserve = Math.max(t.absMinCpuReserve, Math.floor(sys.cores * t.cpuReserveFrac));
  const ramReserveGb = Math.max(t.absMinRamGb, sys.freeGb * t.ramReserveFrac);
  const usableCpus = Math.max(1, sys.cores - cpuReserve);
  const usableRamGb = Math.max(1, sys.freeGb - ramReserveGb);
  const ramBound = Math.floor(usableRamGb / perWorker);

  const knee = MAX_WORKERS_KNEE[mode] ?? 8;
  const workers = Math.max(1, Math.min(usableCpus, ramBound, knee));
  return {
    workers,
    microbatch: t.microbatch,
    detail: {
      cpuReserve,
      ramReserveGb: Math.round(ramReserveGb * 10) / 10,
      usableCpus,
      usableRamGb: Math.round(usableRamGb * 10) / 10,
      perWorker,
      ramBound,
    },
  };
}

function parseArgs(argv) {
  const out = { tier: null, mode: null, perWorkerGb: null, help: false, verbose: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--tier" && argv[i + 1]) out.tier = argv[++i];
    else if (argv[i] === "--mode" && argv[i + 1]) out.mode = argv[++i];
    else if (argv[i] === "--per-worker-gb" && argv[i + 1]) out.perWorkerGb = parseFloat(argv[++i]);
    else if (argv[i] === "-v" || argv[i] === "--verbose") out.verbose = true;
    else if (argv[i] === "-h" || argv[i] === "--help") out.help = true;
  }
  return out;
}

function printHelp() {
  process.stdout.write(
    "Usage: node evaluate/recommend-workers.mjs [--tier low|normal|high|max] [--mode embed|rerank] [--per-worker-gb N] [-v]\n\n" +
    "Without --tier, auto-selects based on system specs (cores + free RAM).\n" +
    "Without --mode, prints a table for both modes.\n" +
    "With --tier and --mode, prints `WORKERS=N MICROBATCH=M` for shell eval.\n" +
    "-v / --verbose includes per-tier reservation breakdown.\n\n" +
    "Tiers (impact on host responsiveness):\n" +
    "  low    — system feels untouched (75% reserved)\n" +
    "  normal — minor slowdown, browser snappy (50% reserved)\n" +
    "  high   — noticeable slowdown but responsive (25% reserved)\n" +
    "  max    — host unusable, run still completes (1c+1GB reserved)\n" +
    "  (max is never auto-selected; explicit --tier max only)\n"
  );
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return printHelp();
  const sys = detect();
  const auto = autoTier(sys);

  // Single recommendation mode — machine-readable env line.
  if (args.tier && args.mode) {
    const r = recommend(args.tier, args.mode, sys, args.perWorkerGb);
    process.stdout.write(`WORKERS=${r.workers} MICROBATCH=${r.microbatch}\n`);
    return;
  }

  // Auto-tier + single mode — also machine-readable.
  if (!args.tier && args.mode) {
    const r = recommend(auto, args.mode, sys, args.perWorkerGb);
    process.stdout.write(`WORKERS=${r.workers} MICROBATCH=${r.microbatch} TIER=${auto}\n`);
    return;
  }

  // Default: human-readable table. Highlight auto-selected tier.
  process.stdout.write(
    `System: ${sys.cores} cores, ${sys.totalGb.toFixed(1)} GB RAM (${sys.freeGb.toFixed(1)} GB free), platform=${os.platform()}\n` +
    `Auto-selected tier: \x1b[1m${auto}\x1b[0m  (--tier max requires explicit opt-in)\n\n` +
    `Recommended worker counts (--workers N + QMD_EMBED_MICROBATCH=M):\n\n` +
    `Tier   | Mode   | Workers | Microbatch${args.verbose ? " | Reserve     | Usable      | RAM-bound" : ""}\n` +
    `-------|--------|---------|-----------${args.verbose ? "-|-------------|-------------|----------" : ""}\n`
  );
  for (const tier of ["low", "normal", "high", "max"]) {
    for (const mode of ["embed", "rerank"]) {
      const r = recommend(tier, mode, sys, args.perWorkerGb);
      const marker = tier === auto ? " ←" : "";
      const baseRow = `${tier.padEnd(6)} | ${mode.padEnd(6)} | ${String(r.workers).padEnd(7)} | ${String(r.microbatch).padEnd(10)}`;
      const verboseExtra = args.verbose
        ? ` | ${String(r.detail.cpuReserve + "c+" + r.detail.ramReserveGb + "G").padEnd(12)}` +
          ` | ${String(r.detail.usableCpus + "c+" + r.detail.usableRamGb + "G").padEnd(12)}` +
          ` | ${String(r.detail.ramBound).padEnd(9)}`
        : "";
      process.stdout.write(`${baseRow}${verboseExtra}${marker}\n`);
    }
  }
  process.stdout.write(
    `\nQuick start (auto-tier, embed mode):\n` +
    `  eval $(node evaluate/recommend-workers.mjs --mode embed)\n` +
    `  QMD_EMBED_MICROBATCH=$MICROBATCH npx tsx evaluate/longmemeval/eval.mts \\\n` +
    `    --ds s --limit 100 --no-llm --workers $WORKERS\n`
  );
}

main();
