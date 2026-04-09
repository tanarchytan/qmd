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
 *       "topK": 5,
 *       "scope": "global"
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

// Load env before anything else
loadQmdEnv();

// =============================================================================
// Config
// =============================================================================

interface QmdPluginConfig {
  autoRecall: boolean;
  autoCapture: boolean;
  topK: number;
  scope: string;
  dbPath?: string;
}

const DEFAULT_CONFIG: QmdPluginConfig = {
  autoRecall: true,
  autoCapture: true,
  topK: 5,
  scope: "global",
};

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
  // No kind: "memory" — we complement existing memory systems, don't compete for the slot

  async register(api: OpenClawPluginApi) {
    const rawConfig = api.pluginConfig as Partial<QmdPluginConfig> | undefined;
    const cfg: QmdPluginConfig = { ...DEFAULT_CONFIG, ...rawConfig };

    const _db = getDb(cfg);

    let lastUserMessage = "";
    let currentSessionKey: string | undefined;

    api.logger.info(
      `tanarchy-qmd: registered (autoRecall: ${cfg.autoRecall}, autoCapture: ${cfg.autoCapture}, scope: ${cfg.scope})`,
    );

    // ========================================================================
    // Auto-recall: inject relevant memories before agent response
    // ========================================================================

    if (cfg.autoRecall) {
      // Cache the last user message for recall
      api.on("message_received", (event: { content?: string; sessionKey?: string }) => {
        if (event.content && event.content.length > 5) {
          lastUserMessage = event.content;
          currentSessionKey = event.sessionKey;
        }
      });

      api.on("before_prompt_build", async (context: { messages?: Array<{ role: string; content: string }> }) => {
        if (!lastUserMessage || lastUserMessage.length < 10) return;

        try {
          const memories = await memoryRecall(_db, {
            query: lastUserMessage,
            scope: cfg.scope,
            limit: cfg.topK,
          });

          if (memories.length > 0) {
            const memoryContext = memories
              .map(m => `[${m.category}] ${m.text}`)
              .join("\n");

            // Inject as system message before the conversation
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
          // Extract from the last few messages (user + assistant)
          const recentMessages = event.messages.slice(-4);
          const text = recentMessages
            .map(m => m.role === "user" ? m.content : `Assistant: ${m.content}`)
            .join("\n\n");

          if (text.length < 30) return;

          await extractAndStore(_db, text, cfg.scope);
        } catch (err) {
          api.logger.warn(`tanarchy-qmd capture failed: ${err}`);
        }
      });
    }

    // ========================================================================
    // Dreaming integration
    // ========================================================================
    // OpenClaw's dreaming system (Light → REM → Deep phases) runs on a cron
    // schedule. Since v2026.4.7, it respects the active memory slot plugin.
    //
    // Our integration:
    // 1. On each agent_end, track session count for dream gating
    // 2. Ingest session corpus files from memory/.dreams/session-corpus/
    // 3. Run decay pass as consolidation when triggered
    //
    // The dreaming phases themselves are managed by memory-core.
    // We participate by being the memory slot that receives promoted entries.

    // Session-based dream gate: run consolidation after enough sessions
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

            // Load cursor state
            let cursor: Record<string, { lines: number }> = {};
            try {
              if (existsSync(cursorPath)) cursor = JSON.parse(readFileSync(cursorPath, "utf-8"));
            } catch {}

            const files = readdirSync(corpusDir).filter(f => f.endsWith(".txt")).sort();
            for (const file of files.slice(-7)) { // Last 7 days
              const content = readFileSync(`${corpusDir}/${file}`, "utf-8");
              const lines = content.split("\n").length;

              // Skip if already fully ingested
              if (cursor[file] && cursor[file].lines >= lines) continue;

              if (content.length > 50) {
                await extractAndStore(_db, content, cfg.scope);
              }
              cursor[file] = { lines };
            }

            // Save cursor
            try { mkdirSync(dirname(cursorPath), { recursive: true }); } catch {}
            writeFileSync(cursorPath, JSON.stringify(cursor, null, 2));
          } catch {
            // No corpus dir yet — that's fine
          }

          // 2. Run decay pass (tier promotion/demotion)
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
    // Tools (using OpenClaw SDK registerTool signature)
    // ========================================================================

    const tools = [
      {
        name: "qmd_memory_store",
        description: "Store a memory with auto-dedup and auto-classification",
        parameters: { type: "object", properties: { text: { type: "string" }, category: { type: "string" }, importance: { type: "number" } }, required: ["text"] },
        execute: async (_id: string, params: any) => {
          const result = await memoryStore(_db, { ...params, scope: cfg.scope });
          const msg = result.status === "created" ? `Stored: ${result.id}` : `Duplicate: ${result.duplicate_id}`;
          return { content: [{ type: "text" as const, text: msg }] };
        },
      },
      {
        name: "qmd_memory_recall",
        description: "Search memories by natural language",
        parameters: { type: "object", properties: { query: { type: "string" }, limit: { type: "number" } }, required: ["query"] },
        execute: async (_id: string, params: any) => {
          const results = await memoryRecall(_db, { ...params, scope: cfg.scope });
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
          const result = await extractAndStore(_db, params.text, cfg.scope);
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
    // Session cleanup — prevent unbounded Map growth (from memory-lancedb-pro)
    // ========================================================================

    api.on("session_end", () => {
      // Reset session-scoped state
      lastUserMessage = "";
      currentSessionKey = undefined;
      sessionCount = 0;
    });

    // ========================================================================
    // Startup — run decay pass on boot (from memory-lancedb-pro gateway_start)
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
    // Tool error tracking — store errors as reflection memories
    // (from memory-lancedb-pro after_tool_call)
    // ========================================================================

    api.on("after_tool_call", async (event: { toolName?: string; error?: string }) => {
      if (!event.error || event.error.trim().length === 0) return;
      try {
        const text = `Tool "${event.toolName || 'unknown'}" failed: ${event.error.slice(0, 200)}`;
        await memoryStore(_db, { text, category: "reflection" as any, scope: cfg.scope, importance: 0.3 });
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
