/**
 * llm/remote.ts — Remote LLM (cloud-provider) implementation.
 *
 * Split out from src/llm.ts. Implements the LLM interface using
 * cloud providers (OpenAI-compatible, ZeroEntropy-style, SiliconFlow,
 * Gemini, Nebius) with per-operation configuration: embed, rerank, and
 * query expansion can each use different providers/models/URLs.
 *
 * Zero dependency on LlamaCpp or node-llama-cpp — the plugin/loader paths
 * that disable local inference still get a fully functional remote LLM.
 */

import { homedir } from "os";
import { join } from "path";
import { existsSync, readFileSync } from "fs";

import type {
  LLM,
  EmbedOptions,
  EmbeddingResult,
  GenerateOptions,
  GenerateResult,
  ModelInfo,
  Queryable,
  QueryType,
  RerankDocument,
  RerankDocumentResult,
  RerankOptions,
  RerankResult,
} from "./types.js";

// =============================================================================
// Configuration types
// =============================================================================

export type OperationProvider = 'api' | 'url' | 'gemini';

export type OperationConfig = {
  provider: OperationProvider;
  apiKey: string;
  url?: string;
  model?: string;
};

export type RemoteLLMConfig = {
  embed?: OperationConfig & { dimensions?: number };
  rerank?: OperationConfig & { mode?: 'llm' | 'rerank' };
  queryExpansion?: OperationConfig;
  /** Optional per-operation timeouts (ms). */
  timeoutsMs?: {
    embed?: number;
    rerank?: number;
    generate?: number;
  };
};

// =============================================================================
// fetchWithRetry — shared HTTP helper with timeout + backoff + better errors
// =============================================================================

/**
 * Remote fetch with:
 * - Timeout (AbortController)
 * - Exponential backoff retry with jitter (maxAttempts default: 3)
 * - Better errors (provider/op + HTTP status + response snippet)
 * - Keep-alive hint header
 */
async function fetchWithRetry(
  input: string | URL | Request,
  init: RequestInit | undefined,
  opts: {
    provider: string;
    operation: "embed" | "rerank" | "generate";
    timeoutMs?: number;
    maxAttempts?: number;
    baseDelayMs?: number;
  },
): Promise<Response> {
  const provider = opts.provider;
  const operation = opts.operation;
  const maxAttempts = Math.max(1, opts.maxAttempts ?? 3);
  const baseDelayMs = Math.max(50, opts.baseDelayMs ?? 500);

  const DEFAULT_TIMEOUTS_MS = {
    embed: 30_000,
    rerank: 15_000,
    generate: 60_000,
  } as const;

  const envTimeoutMs = (() => {
    const raw = process.env.LOTL_TIMEOUT_MS;
    if (!raw) return undefined;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
    return Math.round(parsed);
  })();

  const timeoutMs = Math.max(
    1,
    Math.round(
      opts.timeoutMs
        ?? envTimeoutMs
        ?? (operation === "embed"
          ? DEFAULT_TIMEOUTS_MS.embed
          : operation === "rerank"
            ? DEFAULT_TIMEOUTS_MS.rerank
            : DEFAULT_TIMEOUTS_MS.generate)
    )
  );

  const url = (() => {
    if (typeof input === "string") return input;
    if (input instanceof URL) return input.toString();
    return (input as Request).url;
  })();

  const isRetryableStatus = (status: number): boolean =>
    status === 408 || status === 425 || status === 429 || (status >= 500 && status <= 599);

  const getRetryAfterMs = (resp: Response): number | undefined => {
    const raw = resp.headers.get("retry-after");
    if (!raw) return undefined;
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
    const date = Date.parse(raw);
    if (!Number.isFinite(date)) return undefined;
    const diff = date - Date.now();
    return diff > 0 ? diff : undefined;
  };

  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  const backoffDelayMs = (attempt: number): number => {
    const exp = Math.pow(2, Math.max(0, attempt - 1));
    const jitter = Math.random() * baseDelayMs;
    return Math.min(30_000, Math.round(baseDelayMs * exp + jitter));
  };

  const readBodySnippet = async (resp: Response, limit = 500): Promise<string> => {
    try {
      const text = await resp.text();
      const trimmed = text.trim();
      if (!trimmed) return "";
      return trimmed.length > limit ? `${trimmed.slice(0, limit)}…` : trimmed;
    } catch {
      return "";
    }
  };

  const initWithKeepAlive: RequestInit | undefined = init
    ? {
      ...init,
      headers: (() => {
        const headers = new Headers(init.headers);
        if (!headers.has("connection")) headers.set("Connection", "keep-alive");
        return headers;
      })(),
    }
    : init;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`Timeout after ${timeoutMs}ms`)), timeoutMs);

    if (initWithKeepAlive?.signal) {
      const parent = initWithKeepAlive.signal;
      if (parent.aborted) {
        controller.abort(parent.reason);
      } else {
        parent.addEventListener("abort", () => controller.abort(parent.reason), { once: true });
      }
    }

    let resp: Response | null = null;
    let fetchErr: unknown = null;

    try {
      resp = await fetch(input, { ...(initWithKeepAlive || {}), signal: controller.signal });
    } catch (err) {
      fetchErr = err;
    } finally {
      clearTimeout(timer);
    }

    if (resp) {
      if (resp.ok) return resp;

      const status = resp.status;
      const snippet = await readBodySnippet(resp);
      const hint = status === 401 ? ' — check your QMD_*_API_KEY'
        : status === 403 ? ' — API key may lack permissions'
        : status === 404 ? ' — check your QMD_*_URL (endpoint not found)'
        : status === 422 ? ' — check your QMD_*_MODEL (invalid model name)'
        : '';
      const msg = `[${provider}] ${operation} failed (HTTP ${status}${hint}) ${url}${snippet ? ` — ${snippet}` : ""}`;

      const retryable = isRetryableStatus(status);
      if (!retryable || attempt === maxAttempts) {
        throw new Error(msg);
      }

      const retryAfterMs = getRetryAfterMs(resp);
      const delayMs = Math.max(retryAfterMs ?? 0, backoffDelayMs(attempt));
      process.stderr.write(`${msg}\nRetrying in ${Math.round(delayMs / 1000)}s (attempt ${attempt + 1}/${maxAttempts})...\n`);
      await sleep(delayMs);
      continue;
    }

    const errMsg = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
    const msg = `[${provider}] ${operation} error ${url} — ${errMsg}`;

    if (attempt === maxAttempts) {
      throw new Error(msg);
    }

    const delayMs = backoffDelayMs(attempt);
    process.stderr.write(`${msg}\nRetrying in ${Math.round(delayMs / 1000)}s (attempt ${attempt + 1}/${maxAttempts})...\n`);
    await sleep(delayMs);
  }

  throw new Error(`[${provider}] ${operation} failed: exhausted retries`);
}

// =============================================================================
// Rerank prompt: loads from ~/.config/lotl/rerank-prompt.txt if it exists,
// otherwise uses the built-in default.
// =============================================================================

const DEFAULT_RERANK_PROMPT = `你是记忆检索助手。根据查询从候选文档中筛选并提取相关信息。

查询：{{query}}

候选文档：
{{documents}}

规则：
1. 只提取与查询直接相关的文档内容，忽略不相关的
2. 每篇用 [编号] 开头，后面跟提取的核心内容
3. 用纯文本输出，不要JSON，不要markdown格式符
4. 没有相关文档则输出 NONE
5. 多篇文档内容相同或高度重复时，只提取第一篇，跳过后续重复
6. 优先选择原始数据源（如日记、笔记、配置记录），跳过「对话/搜索会话记录」类文档——即包含 memory_search、tool_use、tool_result、assistant回复搜索结果 等痕迹的文档，这些是之前搜索产生的二手转述，不是一手信息

示例格式：
[0] 提取的核心内容
[3] 另一篇的核心内容`;

function buildRerankPrompt(query: string, docsText: string): string {
  const configDir = process.env.LOTL_CONFIG_DIR || join(homedir(), ".config", "lotl");
  const promptPath = join(configDir, "rerank-prompt.txt");
  let template = DEFAULT_RERANK_PROMPT;
  try {
    if (existsSync(promptPath)) {
      template = readFileSync(promptPath, "utf-8");
    }
  } catch { /* ignore read errors, use default */ }
  return template.replace(/\{\{query\}\}/g, query).replace(/\{\{documents\}\}/g, docsText);
}

// =============================================================================
// RemoteLLM — LLM implementation backed by cloud providers
// =============================================================================

export class RemoteLLM implements LLM {
  private readonly config: RemoteLLMConfig;
  // Process-wide throttle for Gemini embed requests. Implemented as a Promise
  // chain so concurrent workers serialize correctly — read+sleep+update as
  // an atomic unit. The previous static-timestamp version had a race where
  // two workers could both observe "no sleep needed" simultaneously and
  // double the effective rate. Static so all RemoteLLM instances share it.
  private static _geminiThrottleChain: Promise<void> = Promise.resolve();

  /** Acquire the gemini throttle slot. Returns when it's safe to fire the
   * next request. Each waiter chains onto the previous so requests serialize
   * even under worker concurrency. */
  private static async _waitForGeminiSlot(intervalMs: number): Promise<void> {
    if (intervalMs <= 0) return;
    const previous = RemoteLLM._geminiThrottleChain;
    let release!: () => void;
    RemoteLLM._geminiThrottleChain = new Promise(r => { release = r; });
    try {
      await previous;
      await new Promise(r => setTimeout(r, intervalMs));
    } finally {
      release();
    }
  }

  constructor(config: RemoteLLMConfig) {
    this.config = config;
  }

  async embed(text: string, options?: EmbedOptions): Promise<EmbeddingResult | null> {
    if (!this.config.embed) throw new Error("RemoteLLM.embed() requires embed config. Set LOTL_EMBED_PROVIDER.");
    const results = await this._embedTexts([text], options);
    return results[0] ?? null;
  }

  async generate(_prompt: string, _options?: GenerateOptions): Promise<GenerateResult | null> {
    throw new Error("RemoteLLM.generate() is not implemented.");
  }

  async modelExists(_model: string): Promise<ModelInfo> {
    throw new Error("RemoteLLM.modelExists() is not implemented.");
  }

  async expandQuery(
    query: string,
    options?: { context?: string; includeLexical?: boolean }
  ): Promise<Queryable[]> {
    const cfg = this.config.queryExpansion;
    if (!cfg) return this.fallbackExpansion(query, options?.includeLexical ?? true);

    const includeLexical = options?.includeLexical ?? true;
    const provider = cfg.provider;
    const apiKey = cfg.apiKey;
    const model = cfg.model;
    const timeoutMs = this.config.timeoutsMs?.generate;

    const prompt = [
      "Expand this search query into exactly 3 lines (no more, no less):",
      "lex: keyword terms (space-separated, not a sentence)",
      "vec: semantic search query",
      "hyde: hypothetical document snippet",
      "",
      `Query: ${query}`,
    ].join("\n");

    try {
      if (provider === 'gemini') {
        const baseUrl = (cfg.url || 'https://generativelanguage.googleapis.com').replace(/\/$/, '');
        const geminiModel = model || 'gemini-2.5-flash';
        const resp = await fetchWithRetry(
          `${baseUrl}/v1beta/models/${encodeURIComponent(geminiModel)}:generateContent`,
          {
            method: "POST",
            headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
            body: JSON.stringify({
              contents: [{ parts: [{ text: prompt }] }],
              generationConfig: { temperature: 0.7, maxOutputTokens: 300 },
            }),
          },
          { provider: "gemini", operation: "generate", timeoutMs },
        );
        const data = await resp.json() as {
          candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
        };
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
        return this.parseExpansionResult(text, query, includeLexical);
      } else {
        // 'api' or 'url'
        const url = provider === 'api'
          ? `${(cfg.url || '').replace(/\/$/, '')}/chat/completions`
          : cfg.url!;
        if (!url || url === '/chat/completions') throw new Error("LOTL_QUERY_EXPANSION_URL is required. Set the base URL (api) or full endpoint (url) for query expansion.");
        const body: Record<string, unknown> = {
          messages: [{ role: "user", content: prompt }],
          max_tokens: 300,
          temperature: 0.7,
        };
        if (model) body.model = model;
        if (model && model.toLowerCase().includes('qwen3')) body.enable_thinking = false;
        const resp = await fetchWithRetry(url, {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }, { provider, operation: "generate", timeoutMs });
        const data = await resp.json() as {
          choices?: Array<{ message?: { content?: string } }>;
        };
        const text = data.choices?.[0]?.message?.content || "";
        return this.parseExpansionResult(text, query, includeLexical);
      }
    } catch (err) {
      const attemptedUrl = cfg.provider === 'gemini'
        ? `${(cfg.url || 'https://generativelanguage.googleapis.com').replace(/\/$/, '')}/v1beta/models/...`
        : (cfg.provider === 'api' ? `${(cfg.url || '').replace(/\/$/, '')}/chat/completions` : cfg.url || '(no url)');
      process.stderr.write(`[queryExpansion] ${attemptedUrl} error: ${err}\n`);
      return this.fallbackExpansion(query, includeLexical);
    }
  }

  /**
   * Send a freeform prompt via the query expansion provider and get text back.
   * Used for memory extraction, LLM conflict resolution, and other non-search calls.
   */
  async chatComplete(prompt: string): Promise<string | null> {
    const cfg = this.config.queryExpansion;
    if (!cfg) return null;
    // Quality fix A+B: pin model + seed for reproducible extraction calls.
    // gemini-2.5-flash → gemini-2.5-flash-001 (Apr 2026 stable checkpoint)
    const SEED = 42;
    // Quality fix C: file-based response cache. Eval scripts set
    // LOTL_LLM_CACHE_PATH to opt in (production code uses an in-memory map).
    const cachePath = process.env.LOTL_LLM_CACHE_PATH;
    let cacheGet: ((p: string, m: string) => string | null) | null = null;
    let cacheSet: ((p: string, m: string, v: string) => void) | null = null;
    if (cachePath && process.env.LOTL_LLM_CACHE !== "off") {
      try {
        const { openCache } = await import("./cache.js");
        const cache = openCache(cachePath);
        cacheGet = (p, m) => cache.get({ model: m, temperature: 0, seed: SEED, prompt: p });
        cacheSet = (p, m, v) => cache.set({ model: m, temperature: 0, seed: SEED, prompt: p }, v);
      } catch { /* cache optional */ }
    }
    try {
      if (cfg.provider === 'gemini') {
        const baseUrl = (cfg.url || 'https://generativelanguage.googleapis.com').replace(/\/$/, '');
        const model = cfg.model || 'gemini-2.5-flash';
        if (cacheGet) {
          const c = cacheGet(prompt, model);
          if (c != null) return c;
        }
        const resp = await fetchWithRetry(
          `${baseUrl}/v1beta/models/${encodeURIComponent(model)}:generateContent`,
          {
            method: "POST",
            headers: { "x-goog-api-key": cfg.apiKey, "Content-Type": "application/json" },
            body: JSON.stringify({
              contents: [{ parts: [{ text: prompt }] }],
              generationConfig: { temperature: 0, seed: SEED, maxOutputTokens: 1000 },
            }),
          },
          { provider: "gemini", operation: "generate", timeoutMs: this.config.timeoutsMs?.generate },
        );
        const data = await resp.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text || null;
        if (text && cacheSet) cacheSet(prompt, model, text);
        return text;
      } else {
        const url = cfg.provider === 'api'
          ? `${(cfg.url || '').replace(/\/$/, '')}/chat/completions`
          : cfg.url!;
        if (!url || url === '/chat/completions') return null;
        const body: Record<string, unknown> = {
          messages: [{ role: "user", content: prompt }],
          max_tokens: 1000,
          temperature: 0,
          seed: SEED,
        };
        if (cfg.model) body.model = cfg.model;
        const resp = await fetchWithRetry(url, {
          method: "POST",
          headers: { Authorization: `Bearer ${cfg.apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }, { provider: cfg.provider, operation: "generate", timeoutMs: this.config.timeoutsMs?.generate });
        const data = await resp.json() as { choices?: Array<{ message?: { content?: string } }> };
        return data.choices?.[0]?.message?.content || null;
      }
    } catch (err) {
      process.stderr.write(`[chatComplete] error: ${err}\n`);
      return null;
    }
  }

  async rerank(
    query: string,
    documents: RerankDocument[],
    options: RerankOptions = {}
  ): Promise<RerankResult> {
    const cfg = this.config.rerank;
    if (!cfg) throw new Error("RemoteLLM.rerank() requires rerank config. Set LOTL_RERANK_PROVIDER.");

    const provider = cfg.provider;
    const apiKey = cfg.apiKey;
    const model = options.model || cfg.model;
    const timeoutMs = options.timeoutMs ?? this.config.timeoutsMs?.rerank;
    const mode = cfg.mode ?? (provider === 'url' ? 'rerank' : 'llm');

    if (provider === 'gemini') {
      return this._rerankWithGemini(query, documents, cfg, model, timeoutMs);
    }

    if (mode === 'rerank') {
      const url = provider === 'api'
        ? `${(cfg.url || '').replace(/\/$/, '')}/rerank`
        : cfg.url!;
      if (!url || url === '/rerank') throw new Error("LOTL_RERANK_URL is required. Set the base URL (api) or full endpoint (url) for reranking.");

      const resp = await fetchWithRetry(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(model ? { model } : {}),
          query,
          documents: documents.map(d => d.text),
          top_n: Math.max(1, documents.length),
        }),
      }, { provider, operation: "rerank", timeoutMs });

      const data = await resp.json() as {
        results?: Array<{ index: number; relevance_score: number }>;
      };
      const results: RerankDocumentResult[] = (data.results || [])
        .map(item => {
          const doc = documents[item.index];
          if (!doc) return null;
          return { file: doc.file, score: item.relevance_score, index: item.index };
        })
        .filter((item): item is RerankDocumentResult => item !== null);
      return { results, model: model || "rerank" };
    }

    // LLM chat-based rerank
    const url = provider === 'api'
      ? `${(cfg.url || '').replace(/\/$/, '')}/chat/completions`
      : cfg.url!;
    if (!url || url === '/chat/completions') throw new Error("LOTL_RERANK_URL is required. Set the base URL (api) or full endpoint (url) for LLM-based reranking.");

    const docsText = documents.map((doc, i) => `[${i}] ${doc.text}`).join("\n---\n");
    const prompt = buildRerankPrompt(query, docsText);
    const body: Record<string, unknown> = {
      messages: [{ role: "user", content: prompt }],
      temperature: 0,
      max_tokens: 2000,
    };
    if (model) body.model = model;

    const resp = await fetchWithRetry(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }, { provider, operation: "rerank", timeoutMs });

    const data = await resp.json() as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const rawText = data.choices?.[0]?.message?.content || "";
    const parsed = this.parsePlainTextExtracts(rawText, documents.length);
    if (parsed.length === 0 && rawText.trim() !== "NONE") {
      process.stderr.write(`[rerank llm] unexpected response format: ${rawText.slice(0, 200)}\n`);
    }
    const results: RerankDocumentResult[] = [];
    for (let rank = 0; rank < parsed.length; rank++) {
      const item = parsed[rank]!;
      const doc = documents[item.index];
      if (!doc) continue;
      results.push({ file: doc.file, score: 1.0 - rank * 0.05, index: item.index, extract: item.extract || undefined });
    }
    return { results, model: model || "llm" };

  }

  async dispose(): Promise<void> {
    // No-op: RemoteLLM has no local resources to dispose.
  }

  // =========================================================================
  // Private helpers
  // =========================================================================

  async embedBatch(texts: string[]): Promise<(EmbeddingResult | null)[]> {
    if (texts.length === 0) return [];
    if (!this.config.embed) throw new Error("RemoteLLM.embedBatch() requires embed config. Set LOTL_EMBED_PROVIDER.");
    return this._embedTexts(texts);
  }

  private async _embedTexts(texts: string[], options?: EmbedOptions): Promise<(EmbeddingResult | null)[]> {
    const cfg = this.config.embed!;
    const provider = cfg.provider;
    const apiKey = cfg.apiKey;
    const model = options?.model || cfg.model;
    const timeoutMs = options?.timeoutMs ?? this.config.timeoutsMs?.embed;
    // BATCH_SIZE: 64 for OpenAI-compatible APIs (high per-request limit),
    // 5 for Gemini free tier (30k TPM cap binding — small batches keep
    // each request well under 5k tokens so the throttle controls steady-
    // state TPM cleanly).
    const geminiBatchSize = Number(process.env.LOTL_GEMINI_EMBED_BATCH_SIZE ?? "5");
    const BATCH_SIZE = provider === 'gemini' ? geminiBatchSize : 64;
    const allResults: (EmbeddingResult | null)[] = new Array(texts.length).fill(null);
    // Gemini rate limit throttle (free tier: 100 RPM, 30k TPM, 1k RPD).
    // TPM is the binding constraint — at BATCH_SIZE=5 averaging ~600 tok/text,
    // each batch is ~3k tokens. 15-sec interval = 4 batches/min × 3k = 12k TPM,
    // safely under the 30k cap with margin for token estimation error.
    // Override via LOTL_GEMINI_EMBED_INTERVAL_MS.
    const geminiIntervalMs = provider === 'gemini'
      ? Number(process.env.LOTL_GEMINI_EMBED_INTERVAL_MS ?? "15000")
      : 0;

    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
      const batch = texts.slice(i, i + BATCH_SIZE);
      const input = batch.length === 1 ? batch[0] : batch;

      try {
        if (provider === 'api') {
          const baseUrl = (cfg.url || '').replace(/\/$/, '');
          if (!baseUrl) throw new Error("LOTL_EMBED_URL is required when LOTL_EMBED_PROVIDER=api. Set the base URL of your embedding endpoint (e.g. https://api.openai.com/v1).");
          const resp = await fetchWithRetry(`${baseUrl}/embeddings`, {
            method: "POST",
            headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
            body: JSON.stringify({ ...(model ? { model } : {}), input, encoding_format: "float" }),
          }, { provider: "api", operation: "embed", timeoutMs });

          const data = await resp.json() as {
            data?: Array<{ embedding: number[]; index?: number }>;
            model?: string;
          };
          const usedModel = data.model || model || "unknown";
          for (const item of data.data || []) {
            const idx = (item.index ?? 0) + i;
            if (idx < allResults.length && item.embedding) {
              allResults[idx] = { embedding: item.embedding, model: usedModel };
            }
          }
        } else if (provider === 'url') {
          const url = cfg.url;
          if (!url) throw new Error("LOTL_EMBED_URL is required when LOTL_EMBED_PROVIDER=url. Set the full endpoint URL for embedding.");
          const body: Record<string, unknown> = { input, input_type: "document" };
          if (model) body.model = model;
          if (cfg.dimensions) body.dimensions = cfg.dimensions;
          const resp = await fetchWithRetry(url, {
            method: "POST",
            headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
            body: JSON.stringify(body),
          }, { provider: "url", operation: "embed", timeoutMs });

          const data = await resp.json() as {
            data?: Array<{ embedding: number[]; index?: number }>;
            results?: Array<{ embedding: number[] | string }>;
            model?: string;
          };
          const usedModel = data.model || model || "unknown";
          if (data.data && data.data.length > 0) {
            for (const item of data.data) {
              const idx = (item.index ?? 0) + i;
              if (idx < allResults.length && item.embedding) {
                allResults[idx] = { embedding: item.embedding, model: usedModel };
              }
            }
          } else if (data.results && data.results.length > 0) {
            for (let j = 0; j < data.results.length; j++) {
              const r = data.results[j]!;
              if (typeof r.embedding !== 'string' && r.embedding) {
                allResults[i + j] = { embedding: r.embedding, model: usedModel };
              }
            }
          }
        } else if (provider === 'gemini') {
          // Gemini Embedding API — uses x-goog-api-key, distinct request shape.
          // Endpoint: POST /v1beta/models/<model>:batchEmbedContents
          // Body: { requests: [{ model: "models/<m>", content: { parts: [{text}] }, outputDimensionality? }] }
          // Default model: gemini-embedding-001 (Gemini Embedding 2 marketing name, 3072d, matryoshka).
          // LOTL_EMBED_DIMENSIONS=1024 is the Google-recommended sweet spot.
          //
          // Throttle + custom retry loop. Bypasses fetchWithRetry because
          // Google embeds RetryInfo in the JSON body's `details` array (not
          // in the HTTP Retry-After header), and we want the throttle slot
          // to be re-acquired for each retry instead of bursting in 1-sec
          // intervals like fetchWithRetry's exponential backoff does.
          const baseUrl = (cfg.url || 'https://generativelanguage.googleapis.com').replace(/\/$/, '');
          const geminiModel = model || 'gemini-embedding-001';
          if (!apiKey) throw new Error("LOTL_EMBED_API_KEY is required when LOTL_EMBED_PROVIDER=gemini.");
          const requests = batch.map(text => ({
            model: `models/${geminiModel}`,
            content: { parts: [{ text }] },
            ...(cfg.dimensions ? { outputDimensionality: cfg.dimensions } : {}),
            // Task type hint — Gemini supports SEMANTIC_SIMILARITY, RETRIEVAL_DOCUMENT,
            // RETRIEVAL_QUERY, etc. Default to RETRIEVAL_DOCUMENT for ingest path
            // (memory recall flips to RETRIEVAL_QUERY via options.isQuery if set).
            taskType: options?.isQuery ? "RETRIEVAL_QUERY" : "RETRIEVAL_DOCUMENT",
          }));
          const reqUrl = `${baseUrl}/v1beta/models/${encodeURIComponent(geminiModel)}:batchEmbedContents`;
          const maxAttempts = 6;
          let respData: { embeddings?: Array<{ values?: number[] }> } | null = null;
          for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            await RemoteLLM._waitForGeminiSlot(geminiIntervalMs);
            const r = await fetch(reqUrl, {
              method: "POST",
              headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
              body: JSON.stringify({ requests }),
              ...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
            });
            if (r.ok) {
              respData = await r.json() as { embeddings?: Array<{ values?: number[] }> };
              break;
            }
            // Parse Google RetryInfo from the JSON body. Format:
            //   { "error": { "details": [{ "@type": ".../RetryInfo", "retryDelay": "60s" }] } }
            const bodyText = await r.text().catch(() => '');
            let retryDelayMs = 0;
            try {
              const errBody = JSON.parse(bodyText) as {
                error?: { details?: Array<{ "@type"?: string; retryDelay?: string }> };
              };
              const retryInfo = errBody.error?.details?.find(d =>
                typeof d["@type"] === "string" && d["@type"].endsWith("RetryInfo"));
              if (retryInfo?.retryDelay) {
                const m = retryInfo.retryDelay.match(/^(\d+(?:\.\d+)?)s$/);
                if (m) retryDelayMs = Math.ceil(Number(m[1]) * 1000);
              }
            } catch { /* not JSON, fall through */ }
            // Fallback: HTTP Retry-After header, or backoff, with a floor.
            if (retryDelayMs === 0) {
              const ra = r.headers.get("retry-after");
              if (ra) retryDelayMs = Math.ceil(Number(ra) * 1000);
              if (!Number.isFinite(retryDelayMs) || retryDelayMs <= 0) {
                retryDelayMs = Math.min(60000, 2000 * Math.pow(2, attempt - 1));
              }
            }
            if (r.status !== 429 && r.status < 500) {
              throw new Error(`[gemini] embed failed (HTTP ${r.status}) ${reqUrl} — ${bodyText.slice(0, 300)}`);
            }
            if (attempt === maxAttempts) {
              throw new Error(`[gemini] embed exhausted ${maxAttempts} retries (last HTTP ${r.status})`);
            }
            process.stderr.write(`[gemini] HTTP ${r.status}, RetryInfo says ${Math.round(retryDelayMs / 1000)}s; sleeping then retrying (${attempt}/${maxAttempts})\n`);
            await new Promise(r => setTimeout(r, retryDelayMs));
          }
          if (respData) {
            const embeddings = respData.embeddings || [];
            for (let j = 0; j < embeddings.length; j++) {
              const vec = embeddings[j]?.values;
              if (vec && vec.length > 0) {
                allResults[i + j] = { embedding: vec, model: geminiModel };
              }
            }
          }
        } else {
          throw new Error(`Unsupported embed provider: ${provider}. Use 'api', 'url', or 'gemini'.`);
        }
      } catch (err) {
        process.stderr.write(`[embed] batch offset ${i} error: ${err}\n`);
      }
    }
    return allResults;
  }

  private async _rerankWithGemini(
    query: string,
    documents: RerankDocument[],
    cfg: OperationConfig,
    model: string | undefined,
    timeoutMs: number | undefined,
  ): Promise<RerankResult> {
    const baseUrl = (cfg.url || 'https://generativelanguage.googleapis.com').replace(/\/$/, '');
    const geminiModel = model || 'gemini-2.5-flash';
    const docsText = documents.map((doc, i) => `[${i}] ${doc.text}`).join("\n---\n");
    const prompt = buildRerankPrompt(query, docsText);

    const resp = await fetchWithRetry(
      `${baseUrl}/v1beta/models/${encodeURIComponent(geminiModel)}:generateContent`,
      {
        method: "POST",
        headers: { "x-goog-api-key": cfg.apiKey, "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0, thinkingConfig: { thinkingBudget: 0 } },
        }),
      },
      { provider: "gemini", operation: "rerank", timeoutMs },
    );

    const data = await resp.json() as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
    const parsed = this.parsePlainTextExtracts(rawText, documents.length);
    if (parsed.length === 0 && rawText.trim() !== "NONE") {
      process.stderr.write(`Gemini rerank: unexpected response format: ${rawText.slice(0, 200)}\n`);
    }
    const results: RerankDocumentResult[] = [];
    for (let rank = 0; rank < parsed.length; rank++) {
      const item = parsed[rank]!;
      const doc = documents[item.index];
      if (!doc) continue;
      results.push({ file: doc.file, score: 1.0 - rank * 0.05, index: item.index, extract: item.extract || undefined });
    }
    return { results, model: geminiModel };
  }

  private parseExpansionResult(text: string, query: string, includeLexical: boolean): Queryable[] {
    const lines = text.trim().split("\n");
    const queryables: Queryable[] = lines
      .map((line: string): Queryable | null => {
        const colonIdx = line.indexOf(":");
        if (colonIdx === -1) return null;
        const type = line.slice(0, colonIdx).trim().toLowerCase();
        if (type !== 'lex' && type !== 'vec' && type !== 'hyde') return null;
        const content = line.slice(colonIdx + 1).trim();
        if (!content) return null;
        return { type: type as QueryType, text: content };
      })
      .filter((q: Queryable | null): q is Queryable => q !== null);

    const filtered = includeLexical ? queryables : queryables.filter(q => q.type !== 'lex');
    if (filtered.length > 0) return filtered;
    return this.fallbackExpansion(query, includeLexical);
  }

  private fallbackExpansion(query: string, includeLexical: boolean): Queryable[] {
    const fallback: Queryable[] = [
      { type: 'vec', text: query },
      { type: 'hyde', text: `Information about ${query}` },
    ];
    if (includeLexical) fallback.unshift({ type: 'lex', text: query });
    return fallback;
  }

  private parsePlainTextExtracts(text: string, maxIndex: number): Array<{ index: number; extract: string }> {
    const results: Array<{ index: number; extract: string }> = [];
    const trimmed = text.trim();
    if (!trimmed || trimmed === "NONE") return results;
    const segments = trimmed.split(/(?=^\[\d+\])/m);
    for (const segment of segments) {
      const match = segment.match(/^\[(\d+)\]\s*([\s\S]*)/);
      if (!match) continue;
      const index = parseInt(match[1]!, 10);
      const extract = match[2]!.trim();
      if (index >= 0 && index < maxIndex && extract.length > 0) {
        results.push({ index, extract });
      }
    }
    return results;
  }
}
