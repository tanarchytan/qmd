/**
 * env.ts - Load Lotl config from ~/.config/lotl/.env
 *
 * Two-tier precedence:
 *   LOTL_* vars  → .env file always wins (overrides stale parent process vars)
 *   all others  → inherited environment wins (standard dotenv behaviour)
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

let _loaded = false;

/**
 * Returns the Lotl config directory:
 *   $LOTL_CONFIG_DIR  →  $XDG_CONFIG_HOME/lotl  →  ~/.config/lotl
 */
export function getLotlConfigDir(): string {
  return (
    process.env.LOTL_CONFIG_DIR ||
    (process.env.XDG_CONFIG_HOME ? join(process.env.XDG_CONFIG_HOME, "lotl") : null) ||
    join(homedir(), ".config", "lotl")
  );
}

/** @deprecated use getLotlConfigDir */
export const getQmdConfigDir = getLotlConfigDir;

/**
 * Load ~/.config/lotl/.env (or $/.env) into process.env.
 * Idempotent — safe to call multiple times; only reads the file once.
 */
export function loadLotlEnv(): void {
  if (_loaded) return;
  _loaded = true;

  const envPath = join(getLotlConfigDir(), ".env");
  if (!existsSync(envPath)) return;

  let content: string;
  try {
    content = readFileSync(envPath, "utf-8");
  } catch {
    return;
  }

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, "");
    if (!key) continue;
    if (key.startsWith("LOTL_")) {
      // Lotl's own config: .env is the source of truth, always override
      process.env[key] = val;
    } else if (!process.env[key]) {
      // Non-Lotl vars: only set if not already present (standard dotenv)
      process.env[key] = val;
    }
  }
}

/** @deprecated use loadLotlEnv */
export const loadQmdEnv = loadLotlEnv;
