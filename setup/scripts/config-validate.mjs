#!/usr/bin/env node
/**
 * config-validate.mjs — Validate QMD configuration.
 *
 * Checks ~/.config/qmd/.env and optionally openclaw.json for common issues.
 *
 * Usage:
 *   node setup/scripts/config-validate.mjs
 *   node setup/scripts/config-validate.mjs --json
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const errors = [];
const warnings = [];

// =============================================================================
// Check .env file
// =============================================================================

const configDir = process.env.QMD_CONFIG_DIR ||
  (process.env.XDG_CONFIG_HOME ? join(process.env.XDG_CONFIG_HOME, "qmd") : null) ||
  join(homedir(), ".config", "qmd");
const envPath = join(configDir, ".env");

if (existsSync(envPath)) {
  const vars = {};
  for (const line of readFileSync(envPath, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (key) vars[key] = val;
  }

  // Check for placeholder keys
  for (const key of Object.keys(vars)) {
    if (key.endsWith("_API_KEY") && vars[key]) {
      const v = vars[key].toLowerCase();
      if (
        v.includes("your-") || v.includes("your_") || v.includes("your ") ||
        v === "xxx" || v === "changeme" || v === "todo" || v === "fixme" ||
        /^x{3,}$/i.test(vars[key]) ||             // XXXX, xxxx
        /^sk-x{5,}$/i.test(vars[key]) ||           // sk-XXXXXXXXX
        /^(paste|insert|enter|add|put)[-_ ]/i.test(vars[key]) ||  // paste_your_key
        v === "" || v === "none" || v === "null"
      ) {
        errors.push(`${key} contains a placeholder value: "${vars[key]}"`);
      }
    }
  }

  // Check dimensions
  const dim = vars.QMD_EMBED_DIMENSIONS;
  if (dim) {
    const n = parseInt(dim);
    if (isNaN(n) || n < 64 || n > 8192) {
      errors.push(`QMD_EMBED_DIMENSIONS=${dim} — must be 64-8192`);
    }
  }

  // Check provider requires API key
  for (const op of ["EMBED", "RERANK", "QUERY_EXPANSION"]) {
    const provider = vars[`QMD_${op}_PROVIDER`];
    if (provider && provider !== "local") {
      if (!vars[`QMD_${op}_API_KEY`]) {
        errors.push(`QMD_${op}_PROVIDER=${provider} but QMD_${op}_API_KEY is not set`);
      }
    }
  }

  if (!vars.QMD_EMBED_PROVIDER && vars.QMD_EMBED_BACKEND !== "transformers") {
    warnings.push("No QMD_EMBED_PROVIDER set and QMD_EMBED_BACKEND!=transformers — embeddings will fail");
  }

  // Check rerank mode
  const rerankMode = vars.QMD_RERANK_MODE;
  if (rerankMode && !["rerank", "llm"].includes(rerankMode)) {
    errors.push(`QMD_RERANK_MODE=${rerankMode} — must be "rerank" or "llm"`);
  }

} else {
  warnings.push(`No .env file found at ${envPath}`);
}

// =============================================================================
// Check openclaw.json
// =============================================================================

const openclawHome = process.env.OPENCLAW_HOME || join(homedir(), ".openclaw");
const openclawJson = join(openclawHome, "openclaw.json");

if (existsSync(openclawJson)) {
  try {
    const config = JSON.parse(readFileSync(openclawJson, "utf-8"));
    const plugins = config?.plugins;

    if (plugins) {
      const entry = plugins?.entries?.["tanarchy-qmd"];
      if (entry) {
        if (!entry.enabled) {
          warnings.push("tanarchy-qmd plugin entry exists but enabled is not true");
        }

        // Check allow list
        const allow = plugins.allow || [];
        if (!allow.includes("tanarchy-qmd")) {
          errors.push('tanarchy-qmd not in plugins.allow — add "tanarchy-qmd" to the allow array');
        }

        // Check config
        const cfg = entry.config || {};
        // Check all provider apiKey fields for placeholders
        for (const section of ["embed", "rerank", "queryExpansion"]) {
          const key = cfg[section]?.apiKey;
          if (key) {
            const k = key.toLowerCase();
            if (
              k.includes("your") || /^x{3,}$/i.test(key) || /^sk-x{5,}$/i.test(key) ||
              k === "changeme" || k === "todo" || k === "" ||
              /^(paste|insert|enter|add|put)[-_ ]/i.test(key)
            ) {
              errors.push(`${section}.apiKey in openclaw.json contains a placeholder: "${key}"`);
            }
          }
        }
      } else {
        warnings.push("No tanarchy-qmd entry in plugins.entries");
      }
    }
  } catch (err) {
    errors.push(`Failed to parse ${openclawJson}: ${err.message}`);
  }
} else {
  // Not an error — OpenClaw is optional
}

// =============================================================================
// Check SQLite database
// =============================================================================

const cacheHome = process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
const dbPath = join(cacheHome, "qmd", "index.sqlite");
if (!existsSync(dbPath)) {
  warnings.push(`No QMD database found at ${dbPath} — run 'qmd collection add' first`);
}

// =============================================================================
// Output
// =============================================================================

const jsonOutput = process.argv.includes("--json");

if (jsonOutput) {
  console.log(JSON.stringify({ errors, warnings, valid: errors.length === 0 }, null, 2));
} else {
  console.log("\nQMD Config Validation\n");

  if (errors.length === 0 && warnings.length === 0) {
    console.log("  All checks passed ✓\n");
  } else {
    for (const e of errors) {
      console.log(`  ✗ ERROR: ${e}`);
    }
    for (const w of warnings) {
      console.log(`  ⚠ WARN:  ${w}`);
    }
    console.log("");
  }
}

process.exit(errors.length > 0 ? 1 : 0);
