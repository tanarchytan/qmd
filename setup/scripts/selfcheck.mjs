#!/usr/bin/env node
/**
 * selfcheck.mjs — Probe QMD embedding/rerank/expansion endpoints.
 *
 * Usage:
 *   node setup/scripts/selfcheck.mjs                    # Read from ~/.config/qmd/.env
 *   node setup/scripts/selfcheck.mjs --config file.json # Read from config file
 *   node setup/scripts/selfcheck.mjs --json             # JSON output
 *   node setup/scripts/selfcheck.mjs --help
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// =============================================================================
// Config loading
// =============================================================================

function loadEnvFile(path) {
  if (!existsSync(path)) return {};
  const vars = {};
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (key) vars[key] = val;
  }
  return vars;
}

function loadConfig(args) {
  const configIdx = args.indexOf("--config");
  if (configIdx !== -1 && args[configIdx + 1]) {
    try {
      const raw = readFileSync(args[configIdx + 1], "utf-8");
      return { source: args[configIdx + 1], ...JSON.parse(raw) };
    } catch (err) {
      console.error(`Error reading config ${args[configIdx + 1]}: ${err.message}`);
      process.exit(1);
    }
  }

  // Default: ~/.config/qmd/.env
  const configDir = process.env.QMD_CONFIG_DIR ||
    (process.env.XDG_CONFIG_HOME ? join(process.env.XDG_CONFIG_HOME, "qmd") : null) ||
    join(homedir(), ".config", "qmd");
  const envPath = join(configDir, ".env");
  const vars = loadEnvFile(envPath);

  return {
    source: envPath,
    embed: vars.QMD_EMBED_PROVIDER ? {
      provider: vars.QMD_EMBED_PROVIDER,
      apiKey: vars.QMD_EMBED_API_KEY,
      url: vars.QMD_EMBED_URL,
      model: vars.QMD_EMBED_MODEL,
      dimensions: vars.QMD_EMBED_DIMENSIONS ? parseInt(vars.QMD_EMBED_DIMENSIONS) : undefined,
    } : undefined,
    rerank: vars.QMD_RERANK_PROVIDER ? {
      provider: vars.QMD_RERANK_PROVIDER,
      apiKey: vars.QMD_RERANK_API_KEY,
      url: vars.QMD_RERANK_URL,
      model: vars.QMD_RERANK_MODEL,
    } : undefined,
    queryExpansion: vars.QMD_QUERY_EXPANSION_PROVIDER ? {
      provider: vars.QMD_QUERY_EXPANSION_PROVIDER,
      apiKey: vars.QMD_QUERY_EXPANSION_API_KEY,
      url: vars.QMD_QUERY_EXPANSION_URL,
      model: vars.QMD_QUERY_EXPANSION_MODEL,
    } : undefined,
  };
}

// =============================================================================
// Provider URL resolution
// =============================================================================

function resolveEmbedUrl(cfg) {
  const p = cfg.provider;
  const base = cfg.url;
  if (p === "siliconflow") return "https://api.siliconflow.cn/v1/embeddings";
  if (p === "openai") return "https://api.openai.com/v1/embeddings";
  if (p === "zeroentropy") return cfg.url || "https://api.zeroentropy.dev/v1/models/embed";
  if (p === "api" && base) return `${base.replace(/\/$/, "")}/embeddings`;
  if (p === "url") return cfg.url;
  return null;
}

function resolveRerankUrl(cfg) {
  const p = cfg.provider;
  if (p === "siliconflow") return "https://api.siliconflow.cn/v1/rerank";
  if (p === "zeroentropy") return cfg.url || "https://api.zeroentropy.dev/v1/models/rerank";
  if (p === "dashscope") return cfg.url || "https://dashscope.aliyuncs.com/compatible-api/v1/reranks";
  if (p === "api" && cfg.url) return `${cfg.url.replace(/\/$/, "")}/rerank`;
  if (p === "url") return cfg.url;
  return null;
}

function resolveExpansionUrl(cfg) {
  const p = cfg.provider;
  if (p === "siliconflow") return "https://api.siliconflow.cn/v1/chat/completions";
  if (p === "openai") return "https://api.openai.com/v1/chat/completions";
  if (p === "api" && cfg.url) return `${cfg.url.replace(/\/$/, "")}/chat/completions`;
  if (p === "url") return cfg.url;
  return null;
}

// =============================================================================
// Probes
// =============================================================================

async function probeEmbed(cfg) {
  const url = resolveEmbedUrl(cfg);
  if (!url) return { status: "skip", message: "No embed URL resolved" };

  const start = Date.now();
  try {
    const body = { model: cfg.model, input: "The quick brown fox jumps over the lazy dog" };
    if (cfg.dimensions) body.dimensions = cfg.dimensions;

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${cfg.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });

    const latency = Date.now() - start;
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { status: "fail", message: `HTTP ${res.status}: ${text.slice(0, 200)}`, latency };
    }

    const data = await res.json();
    const embedding = data?.data?.[0]?.embedding;
    if (!embedding || !Array.isArray(embedding)) {
      return { status: "fail", message: "No embedding in response", latency };
    }

    const dim = embedding.length;
    const dimMatch = !cfg.dimensions || dim === cfg.dimensions;
    return {
      status: dimMatch ? "pass" : "warn",
      message: dimMatch
        ? `OK — ${dim} dimensions, ${latency}ms`
        : `Dimension mismatch: got ${dim}, expected ${cfg.dimensions}`,
      latency,
      dimensions: dim,
    };
  } catch (err) {
    return { status: "fail", message: err.message, latency: Date.now() - start };
  }
}

async function probeRerank(cfg) {
  const url = resolveRerankUrl(cfg);
  if (!url) return { status: "skip", message: "No rerank URL resolved" };

  const start = Date.now();
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${cfg.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: cfg.model,
        query: "What is machine learning?",
        documents: [
          "Machine learning is a subset of artificial intelligence.",
          "The weather today is sunny.",
          "Neural networks are used in deep learning.",
        ],
        top_n: 2,
      }),
      signal: AbortSignal.timeout(15000),
    });

    const latency = Date.now() - start;
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { status: "fail", message: `HTTP ${res.status}: ${text.slice(0, 200)}`, latency };
    }

    const data = await res.json();
    const results = data?.results || data?.data;
    if (!results || !Array.isArray(results)) {
      return { status: "fail", message: "No rerank results in response", latency };
    }

    return {
      status: "pass",
      message: `OK — ${results.length} results, ${latency}ms`,
      latency,
      resultCount: results.length,
    };
  } catch (err) {
    return { status: "fail", message: err.message, latency: Date.now() - start };
  }
}

async function probeExpansion(cfg) {
  const url = resolveExpansionUrl(cfg);
  if (!url) return { status: "skip", message: "No expansion URL resolved" };

  const start = Date.now();
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${cfg.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: cfg.model,
        messages: [{ role: "user", content: "Reply with exactly: OK" }],
        max_tokens: 10,
      }),
      signal: AbortSignal.timeout(20000),
    });

    const latency = Date.now() - start;
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { status: "fail", message: `HTTP ${res.status}: ${text.slice(0, 200)}`, latency };
    }

    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content;
    return {
      status: content ? "pass" : "warn",
      message: content ? `OK — ${latency}ms` : `Empty response, ${latency}ms`,
      latency,
    };
  } catch (err) {
    return { status: "fail", message: err.message, latency: Date.now() - start };
  }
}

// =============================================================================
// Main
// =============================================================================

const args = process.argv.slice(2);

if (args.includes("--help") || args.includes("-h")) {
  console.log("selfcheck.mjs — Probe QMD endpoints");
  console.log("");
  console.log("Usage:");
  console.log("  node setup/scripts/selfcheck.mjs                    # Read ~/.config/qmd/.env");
  console.log("  node setup/scripts/selfcheck.mjs --config file.json # Read config file");
  console.log("  node setup/scripts/selfcheck.mjs --json             # JSON output");
  process.exit(0);
}

const jsonOutput = args.includes("--json");
const config = loadConfig(args);

const results = {};

if (!jsonOutput) console.log(`\nQMD Self-Check (config: ${config.source})\n`);

// Embed
if (config.embed) {
  if (!jsonOutput) process.stdout.write("  Embed:     ");
  results.embed = await probeEmbed(config.embed);
  if (!jsonOutput) {
    const icon = results.embed.status === "pass" ? "✓" : results.embed.status === "warn" ? "⚠" : "✗";
    console.log(`${icon} ${results.embed.message}`);
  }
} else {
  results.embed = { status: "skip", message: "Not configured" };
  if (!jsonOutput) console.log("  Embed:     - Not configured");
}

// Rerank
if (config.rerank) {
  if (!jsonOutput) process.stdout.write("  Rerank:    ");
  results.rerank = await probeRerank(config.rerank);
  if (!jsonOutput) {
    const icon = results.rerank.status === "pass" ? "✓" : results.rerank.status === "warn" ? "⚠" : "✗";
    console.log(`${icon} ${results.rerank.message}`);
  }
} else {
  results.rerank = { status: "skip", message: "Not configured" };
  if (!jsonOutput) console.log("  Rerank:    - Not configured");
}

// Expansion
if (config.queryExpansion) {
  if (!jsonOutput) process.stdout.write("  Expansion: ");
  results.expansion = await probeExpansion(config.queryExpansion);
  if (!jsonOutput) {
    const icon = results.expansion.status === "pass" ? "✓" : results.expansion.status === "warn" ? "⚠" : "✗";
    console.log(`${icon} ${results.expansion.message}`);
  }
} else {
  results.expansion = { status: "skip", message: "Not configured" };
  if (!jsonOutput) console.log("  Expansion: - Not configured");
}

if (jsonOutput) {
  console.log(JSON.stringify(results, null, 2));
} else {
  const hasFail = Object.values(results).some(r => r.status === "fail");
  const allSkip = Object.values(results).every(r => r.status === "skip");
  console.log("");
  if (allSkip) {
    console.log("  No providers configured. Run setup-qmd.sh or edit ~/.config/qmd/.env");
  } else if (hasFail) {
    console.log("  ⚠ Some endpoints failed. Check API keys and model names.");
  } else {
    console.log("  All endpoints OK ✓");
  }
  console.log("");
}

process.exit(Object.values(results).some(r => r.status === "fail") ? 1 : 0);
