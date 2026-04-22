/**
 * Eval-only env var namespace compat bridge.
 *
 * Phase E (#47) — rename eval-only `LOTL_*` env vars to `LOTL_EVAL_*` so
 * production runtime config stays visually separable from bench-harness
 * tuning. This bridge copies old names to new names at startup so existing
 * scripts (phase-b-gemma.sh, sweep-flags.sh, etc.) keep working; docs +
 * new scripts use `LOTL_EVAL_*` exclusively.
 *
 * Old → new mapping (reverse also: LOTL_EVAL_X → LOTL_X so any code still
 * reading LOTL_X keeps seeing the value a user sets via LOTL_EVAL_X).
 *
 * Reverse order matters: if a user sets BOTH (migrating), LOTL_EVAL_* wins.
 *
 * Call `applyEvalEnvCompat()` at the very top of any eval entry point,
 * BEFORE `src/env.ts` is loaded or memory/llm modules import.
 */

export const EVAL_ONLY_VARS = [
  // Answer-prompt tuning (eval-only)
  "ANSWER_CACHE",
  "ANSWER_CACHE_DIR",
  "ANSWER_MAX_CHARS",
  "ANSWER_MAX_TOKENS",
  "ANSWER_TOP_K",
  // Ingest-mode switches (eval-only, separate from production ingest toggles)
  "INGEST_BATCH_EXTRACT",
  "INGEST_EXTRACTION",
  "INGEST_PER_TURN",
  "INGEST_SESSION_AS_MEMORY",
  "INGEST_SYNTHESIS",
  "INGEST_USER_ONLY",
  // Judge orchestration
  "JUDGE_API_KEY",
  "JUDGE_MAX_TOKENS",
  "JUDGE_MODEL",
  "JUDGE_RUNS",
  "JUDGE_TEMPERATURE",
  "JUDGE_TIMEOUT_MS",
  "JUDGE_URL",
  // Worker pools
  "LME_WORKERS",
  "LOCOMO_WORKERS",
  // Local LLM model overrides (eval-only)
  "LMSTUDIO_GEN_MODEL",
  "LMSTUDIO_JUDGE_MODEL",
  "LOCOMO_ANSWER_TOP_K",
  "LOCOMO_JUDGE",
  "POE_MODEL",
  // Prompt variant selection
  "PROMPT_RULES",
  // Recall-pipeline eval toggles (distinct from production LOTL_MEMORY_*)
  "RECALL_NO_TOUCH",
  // Preflight skip
  "SKIP_PREFLIGHT",
  // Partial-result cadence
  "PARTIAL_EVERY",
] as const;

/**
 * Copy old LOTL_X → LOTL_EVAL_X (and reverse) to keep scripts working during
 * the migration window. No-op if both are set or neither is set.
 */
export function applyEvalEnvCompat(): void {
  for (const suffix of EVAL_ONLY_VARS) {
    const oldKey = `LOTL_${suffix}`;
    const newKey = `LOTL_EVAL_${suffix}`;
    const oldVal = process.env[oldKey];
    const newVal = process.env[newKey];
    if (newVal !== undefined && oldVal === undefined) {
      // New name set, old not — mirror so any legacy reader finds it
      process.env[oldKey] = newVal;
    } else if (oldVal !== undefined && newVal === undefined) {
      // Old name set, new not — mirror so new-name reader finds it
      process.env[newKey] = oldVal;
    }
    // If both set: leave as-is (new wins semantically but both env vars present)
  }
}

/** Read an eval-only var preferring new name, falling back to old. */
export function evalEnv(suffix: string): string | undefined {
  return process.env[`LOTL_EVAL_${suffix}`] ?? process.env[`LOTL_${suffix}`];
}
