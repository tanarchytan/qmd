/**
 * openclaw/plugin.ts — QMD memory + knowledge plugin for OpenClaw.
 *
 * IMPORTANT: OpenClaw already has built-in QMD support as a memory backend
 * (memory.backend = "qmd"). That handles document search, indexing, and
 * session transcript export automatically.
 *
 * This plugin ADDS on top of the built-in backend:
 * - Conversation memory (memory_store/recall/forget/extract/update)
 * - Knowledge graph (knowledge_store/query/invalidate)
 * - Auto-capture: extracts memories from conversations after each turn
 * - Auto-recall: injects relevant memories before each turn
 * - Dream consolidation: decay pass + session corpus ingestion
 *
 * Use both together:
 *   memory.backend = "qmd"          ← built-in document search
 *   plugins.tanarchy-qmd.enabled    ← this plugin for memory + knowledge
 *
 * Install: openclaw plugins install @tanarchy/qmd
 * Config in openclaw.json:
 *   "tanarchy-qmd": {
 *     "enabled": true,
 *     "config": {
 *       "autoRecall": true,
 *       "autoCapture": true,
 *       "embed": { "provider": "zeroentropy", "apiKey": "...", "model": "zembed-1" },
 *       "rerank": { "provider": "zeroentropy", "apiKey": "...", "model": "zerank-2" }
 *     }
 *   }
 */

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { loadQmdEnv } from "../env.js";
import { openDatabase, loadSqliteVec } from "../db.js";
import {
  memoryStore, memoryRecall, memoryForget, memoryUpdate, memoryStats,
  extractAndStore, runDecayPass, knowledgeStore, knowledgeQuery,
  knowledgeInvalidate, knowledgeEntities,
} from "../memory/index.js";

// =============================================================================
// Config
// =============================================================================

interface ProviderConfig {
  provider?: string;
  apiKey?: string;
  url?: string;
  model?: string;
  dimensions?: number;
  mode?: string;
}

interface QmdPluginConfig {
  autoRecall: boolean;
  autoCapture: boolean;
  topK: number;
  scope: string;
  dbPath?: string;
  local?: boolean;
  embed?: ProviderConfig;
  rerank?: ProviderConfig;
  queryExpansion?: ProviderConfig;
}

const DEFAULT_CONFIG: QmdPluginConfig = {
  autoRecall: true,
  autoCapture: true,
  topK: 5,
  scope: "global",
};

// =============================================================================
// Config → env mapping
// =============================================================================

/**
 * Map openclaw.json plugin config to QMD_* environment variables.
 * Called AFTER loadQmdEnv() so plugin config wins over .env file.
 */
function applyConfigToEnv(cfg: QmdPluginConfig): void {
  // Plugin default: remote-only (no cmake/GPU needed)
  if (cfg.local === false || cfg.local === undefined) {
    process.env.QMD_LOCAL = "no";
  } else {
    process.env.QMD_LOCAL = "yes";
  }

  if (cfg.embed) {
    if (cfg.embed.provider) process.env.QMD_EMBED_PROVIDER = cfg.embed.provider;
    if (cfg.embed.apiKey) process.env.QMD_EMBED_API_KEY = cfg.embed.apiKey;
    if (cfg.embed.url) process.env.QMD_EMBED_URL = cfg.embed.url;
    if (cfg.embed.model) process.env.QMD_EMBED_MODEL = cfg.embed.model;
    if (cfg.embed.dimensions) process.env.QMD_EMBED_DIMENSIONS = String(cfg.embed.dimensions);
  }

  if (cfg.rerank) {
    if (cfg.rerank.provider) process.env.QMD_RERANK_PROVIDER = cfg.rerank.provider;
    if (cfg.rerank.apiKey) process.env.QMD_RERANK_API_KEY = cfg.rerank.apiKey;
    if (cfg.rerank.url) process.env.QMD_RERANK_URL = cfg.rerank.url;
    if (cfg.rerank.model) process.env.QMD_RERANK_MODEL = cfg.rerank.model;
    if (cfg.rerank.mode) process.env.QMD_RERANK_MODE = cfg.rerank.mode;
  }

  if (cfg.queryExpansion) {
    if (cfg.queryExpansion.provider) process.env.QMD_QUERY_EXPANSION_PROVIDER = cfg.queryExpansion.provider;
    if (cfg.queryExpansion.apiKey) process.env.QMD_QUERY_EXPANSION_API_KEY = cfg.queryExpansion.apiKey;
    if (cfg.queryExpansion.url) process.env.QMD_QUERY_EXPANSION_URL = cfg.queryExpansion.url;
    if (cfg.queryExpansion.model) process.env.QMD_QUERY_EXPANSION_MODEL = cfg.queryExpansion.model;
  }
}

// =============================================================================
// Database
// =============================================================================

function getDb(config: QmdPluginConfig) {
  const dbPath = config.dbPath || (
    process.env.XDG_CACHE_HOME
      ? `${process.env.XDG_CACHE_HOME}/qmd/index.sqlite`
      : `${process.env.HOME || process.env.USERPROFILE}/.cache/qmd/index.sqlite`
  );
  const db = openDatabase(dbPath);
  try { loadSqliteVec(db); } catch {}
  return db;
}

// =============================================================================
// Plugin
// =============================================================================

const qmdPlugin = definePluginEntry({
  id: "tanarchy-qmd",
  name: "Tanarchy QMD",
  description: "Document search + conversation memory + knowledge graph powered by QMD",

  async register(api: OpenClawPluginApi) {
    const rawConfig = api.pluginConfig as Partial<QmdPluginConfig> | undefined;
    const cfg: QmdPluginConfig = { ...DEFAULT_CONFIG, ...rawConfig };

    // 1. Load .env defaults, then override with plugin config
    loadQmdEnv();
    applyConfigToEnv(cfg);

    const _db = getDb(cfg);
    const defaultScope = cfg.scope;

    // Per-request state — scoped per message, not shared across agents
    let lastUserMessage = "";
    let activeScope = defaultScope;

    api.logger.info(
      `tanarchy-qmd: registered (autoRecall: ${cfg.autoRecall}, autoCapture: ${cfg.autoCapture}, scope: ${defaultScope})`,
    );

    // ========================================================================
    // Helper: resolve scope for a session key
    // ========================================================================

    function resolveScope(sessionKey?: string): string {
      if (sessionKey) {
        const match = sessionKey.match(/^agent:([^:]+)/);
        if (match) return `agent:${match[1]}`;
      }
      return defaultScope;
    }

    // ========================================================================
    // Auto-recall: inject relevant memories before agent response
    // ========================================================================

    if (cfg.autoRecall) {
      api.on("message_received", (event: { content?: string; sessionKey?: string }) => {
        if (event.content && event.content.length > 5) {
          lastUserMessage = event.content;
          activeScope = resolveScope(event.sessionKey);
        }
      });

      api.on("before_prompt_build", async (context: { messages?: Array<{ role: string; content: string }> }) => {
        if (!lastUserMessage || lastUserMessage.length < 10) return;

        try {
          // Search both agent-scoped AND global memories
          const scope = activeScope;
          const scopes = [scope];
          if (scope !== "global" && scope.startsWith("agent:")) {
            scopes.push("global");
          }

          const allMemories: Array<{ category: string; text: string; score: number }> = [];
          for (const s of scopes) {
            const memories = await memoryRecall(_db, {
              query: lastUserMessage,
              scope: s,
              limit: cfg.topK,
            });
            allMemories.push(...memories);
          }

          // Dedupe by text and sort by score
          const seen = new Set<string>();
          const dedupedMemories = allMemories.filter(m => {
            if (seen.has(m.text)) return false;
            seen.add(m.text);
            return true;
          }).sort((a, b) => b.score - a.score).slice(0, cfg.topK);

          if (dedupedMemories.length > 0) {
            const memoryContext = dedupedMemories
              .map(m => `[${m.category}] ${m.text}`)
              .join("\n");

            if (context.messages) {
              context.messages.unshift({
                role: "system",
                content: `Relevant memories:\n${memoryContext}`,
              });
            }
          }
        } catch (err) {
          api.logger.warn(`tanarchy-qmd recall failed: ${err}`);
        }
      });
    }

    // ========================================================================
    // Auto-capture: extract memories from conversation after agent response
    // ========================================================================

    if (cfg.autoCapture) {
      api.on("agent_end", async (event: { messages?: Array<{ role: string; content: string }> }) => {
        if (!event.messages || event.messages.length === 0) return;

        try {
          const recentMessages = event.messages.slice(-4);
          const text = recentMessages
            .map(m => m.role === "user" ? m.content : `Assistant: ${m.content}`)
            .join("\n\n");

          if (text.length < 30) return;

          await extractAndStore(_db, text, activeScope);
        } catch (err) {
          api.logger.warn(`tanarchy-qmd capture failed: ${err}`);
        }
      });
    }

    // ========================================================================
    // Dreaming integration
    // ========================================================================

    let sessionCount = 0;
    const DREAM_SESSION_THRESHOLD = 5;
    const DREAM_HOURS_THRESHOLD = 24;
    let lastDreamAt = 0;

    api.on("agent_end", async () => {
      sessionCount++;
      const hoursSince = (Date.now() - lastDreamAt) / 3_600_000;

      if (sessionCount >= DREAM_SESSION_THRESHOLD && hoursSince >= DREAM_HOURS_THRESHOLD) {
        try {
          api.logger.info("tanarchy-qmd: dream gate passed, running consolidation");

          // 1. Ingest session corpus files with cursor checkpointing
          const corpusDir = `${process.env.HOME || process.env.USERPROFILE}/.openclaw/memory/.dreams/session-corpus`;
          const cursorPath = `${process.env.HOME || process.env.USERPROFILE}/.config/qmd/dream-ingestion.json`;
          try {
            const { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync } = await import("node:fs");
            const { dirname } = await import("node:path");

            let cursor: Record<string, { lines: number }> = {};
            try {
              if (existsSync(cursorPath)) cursor = JSON.parse(readFileSync(cursorPath, "utf-8"));
            } catch {}

            const files = readdirSync(corpusDir).filter(f => f.endsWith(".txt")).sort();
            for (const file of files.slice(-7)) {
              const content = readFileSync(`${corpusDir}/${file}`, "utf-8");
              const lines = content.split("\n").length;

              if (cursor[file] && cursor[file].lines >= lines) continue;

              if (content.length > 50) {
                await extractAndStore(_db, content, defaultScope);
              }
              cursor[file] = { lines };
            }

            try { mkdirSync(dirname(cursorPath), { recursive: true }); } catch {}
            writeFileSync(cursorPath, JSON.stringify(cursor, null, 2));
          } catch {
            // No corpus dir yet — that's fine
          }

          // 2. Run decay pass
          const result = runDecayPass(_db);
          api.logger.info(
            `tanarchy-qmd: consolidation complete — ${result.processed} memories, ` +
            `${result.promoted} promoted, ${result.demoted} demoted`,
          );

          lastDreamAt = Date.now();
          sessionCount = 0;
        } catch (err) {
          api.logger.warn(`tanarchy-qmd consolidation failed: ${err}`);
        }
      }
    });

    // ========================================================================
    // Tools
    // ========================================================================

    const tools = [
      {
        name: "qmd_memory_store",
        description: "Store a memory with auto-dedup and auto-classification",
        parameters: { type: "object", properties: { text: { type: "string" }, category: { type: "string" }, importance: { type: "number" } }, required: ["text"] },
        execute: async (_id: string, params: any) => {
          const result = await memoryStore(_db, { ...params, scope: activeScope });
          const msg = result.status === "created" ? `Stored: ${result.id}` : `Duplicate: ${result.duplicate_id}`;
          return { content: [{ type: "text" as const, text: msg }] };
        },
      },
      {
        name: "qmd_memory_recall",
        description: "Search memories by natural language",
        parameters: { type: "object", properties: { query: { type: "string" }, limit: { type: "number" } }, required: ["query"] },
        execute: async (_id: string, params: any) => {
          const results = await memoryRecall(_db, { ...params, scope: activeScope });
          const text = results.length === 0
            ? "No memories found."
            : results.map((r, i) => `${i + 1}. [${r.category}] ${r.text} (score: ${r.score.toFixed(2)})`).join("\n");
          return { content: [{ type: "text" as const, text }] };
        },
      },
      {
        name: "qmd_memory_forget",
        description: "Delete a memory by ID",
        parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
        execute: async (_id: string, params: any) => {
          const result = memoryForget(_db, params.id);
          return { content: [{ type: "text" as const, text: result.deleted ? `Deleted: ${params.id}` : `Not found: ${params.id}` }] };
        },
      },
      {
        name: "qmd_memory_extract",
        description: "Extract memories from conversation text",
        parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
        execute: async (_id: string, params: any) => {
          const result = await extractAndStore(_db, params.text, activeScope);
          return { content: [{ type: "text" as const, text: `Extracted ${result.extracted.length}: ${result.stored} stored, ${result.duplicates} duplicates` }] };
        },
      },
      {
        name: "qmd_knowledge_store",
        description: "Store a temporal fact (auto-invalidates conflicts)",
        parameters: { type: "object", properties: { subject: { type: "string" }, predicate: { type: "string" }, object: { type: "string" } }, required: ["subject", "predicate", "object"] },
        execute: async (_id: string, params: any) => {
          const result = knowledgeStore(_db, params);
          const msg = result.invalidated.length > 0
            ? `Stored (${result.id}), invalidated ${result.invalidated.length} prior`
            : `Stored (${result.id})`;
          return { content: [{ type: "text" as const, text: msg }] };
        },
      },
      {
        name: "qmd_knowledge_query",
        description: "Query the knowledge graph",
        parameters: { type: "object", properties: { subject: { type: "string" }, predicate: { type: "string" } } },
        execute: async (_id: string, params: any) => {
          const results = knowledgeQuery(_db, params);
          const text = results.length === 0
            ? "No facts found."
            : results.map(r => `${r.subject} → ${r.predicate} → ${r.object}`).join("\n");
          return { content: [{ type: "text" as const, text }] };
        },
      },
      {
        name: "qmd_memory_stats",
        description: "Memory statistics by tier, category, scope",
        parameters: { type: "object", properties: {} },
        execute: async () => {
          const stats = memoryStats(_db);
          return { content: [{ type: "text" as const, text: `Total: ${stats.total}\nTiers: ${JSON.stringify(stats.byTier)}\nCategories: ${JSON.stringify(stats.byCategory)}` }] };
        },
      },
    ];

    for (const tool of tools) {
      api.registerTool(tool as any);
    }

    // ========================================================================
    // Session cleanup
    // ========================================================================

    api.on("session_end", () => {
      lastUserMessage = "";
      activeScope = defaultScope;
      sessionCount = 0;
    });

    // ========================================================================
    // Startup — run decay pass on boot
    // ========================================================================

    api.on("gateway_start", () => {
      try {
        const result = runDecayPass(_db);
        if (result.promoted > 0 || result.demoted > 0) {
          api.logger.info(
            `tanarchy-qmd: startup decay — ${result.promoted} promoted, ${result.demoted} demoted`,
          );
        }
      } catch (err) {
        api.logger.warn(`tanarchy-qmd: startup decay failed: ${err}`);
      }
    });

    // ========================================================================
    // Tool error tracking
    // ========================================================================

    api.on("after_tool_call", async (event: { toolName?: string; error?: string }) => {
      if (!event.error || event.error.trim().length === 0) return;
      try {
        const text = `Tool "${event.toolName || 'unknown'}" failed: ${event.error.slice(0, 200)}`;
        await memoryStore(_db, { text, category: "reflection" as any, scope: activeScope, importance: 0.3 });
      } catch {
        // Don't let error tracking break the flow
      }
    });

    // ========================================================================
    // Service lifecycle
    // ========================================================================

    api.registerService({
      id: "tanarchy-qmd",
      start: () => {
        api.logger.info("tanarchy-qmd: memory service started");
      },
      stop: () => {
        try { if (_db) _db.close(); } catch {}
        api.logger.info("tanarchy-qmd: memory service stopped");
      },
    });
  },
});

export default qmdPlugin;
