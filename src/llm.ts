/**
 * llm.ts — Facade for the LLM abstraction layer.
 *
 * After the 2026-04-13 cleanup, QMD has exactly two LLM providers:
 *
 *   - RemoteLLM (src/llm/remote.ts)        — cloud APIs (ZE, Gemini, OpenAI, etc.)
 *   - TransformersEmbedBackend             — local ONNX embed via @huggingface/transformers
 *     (src/llm/transformers-embed.ts)
 *
 * node-llama-cpp (LlamaCpp) and fastembed-js were removed in the same cleanup —
 * neither was actually exercised in production (.env had QMD_LOCAL=no, embed
 * went through fastembed which only loaded a fixed enum of 4 models, rerank +
 * generate always went through RemoteLLM). The transformers backend now covers
 * arbitrary HF ONNX embed models with a much smaller dep footprint and zero
 * cmake build burden.
 *
 * Rerank + generate are remote-only. There is no local fallback for them —
 * if no remote provider is configured, those operations return null/skip.
 */

// Shared types, default URIs, embedding format helpers (src/llm/types.ts)
export {
  DEFAULT_EMBED_MODEL,
  DEFAULT_RERANK_MODEL,
  DEFAULT_GENERATE_MODEL,
  DEFAULT_EMBED_MODEL_URI,
  DEFAULT_RERANK_MODEL_URI,
  DEFAULT_GENERATE_MODEL_URI,
  formatQueryForEmbedding,
  formatDocForEmbedding,
} from "./llm/types.js";
export type {
  LLM,
  ILLMSession,
  TokenLogProb,
  EmbeddingResult,
  GenerateResult,
  RerankDocumentResult,
  RerankResult,
  ModelInfo,
  EmbedOptions,
  GenerateOptions,
  RerankOptions,
  LLMSessionOptions,
  QueryType,
  Queryable,
  RerankDocument,
} from "./llm/types.js";

// Local embed backend (src/llm/transformers-embed.ts)
export {
  TransformersEmbedBackend,
  createTransformersEmbedBackend,
} from "./llm/transformers-embed.js";

// Generic session machinery (src/llm/session.ts)
export {
  LLMSessionManager,
  LLMSession,
  SessionReleasedError,
  withLLMSessionForLlm,
} from "./llm/session.js";

// Remote (cloud-provider) implementation (src/llm/remote.ts)
export { RemoteLLM } from "./llm/remote.js";
export type { OperationProvider, OperationConfig, RemoteLLMConfig } from "./llm/remote.js";

// =============================================================================
// Default-singleton helpers — kept as no-op stubs for backwards compat.
// Pre-cleanup, these returned a LlamaCpp instance + managed an idle timer.
// Post-cleanup, there is no singleton: TransformersEmbedBackend is constructed
// per-call inside src/memory/index.ts and the document search pipeline routes
// through RemoteLLM directly. These stubs exist so external callers that still
// import the symbols compile cleanly.
// =============================================================================

/** @deprecated LlamaCpp removed; always returns false. */
export function isLocalEnabled(): boolean { return false; }

/**
 * @deprecated LlamaCpp removed in the 2026-04-13 cleanup.
 * Returns a no-op LLM stub so legacy callers (test fixtures, old probes)
 * compile and run without crashing — every method returns null/empty.
 * New code should use TransformersEmbedBackend (local embed) or RemoteLLM
 * (rerank/generate) directly.
 */
export function getDefaultLlamaCpp(): any {
  return _noopLlmStub;
}

const _noopLlmStub = {
  embedModelName: "noop",
  embed: async () => null,
  embedBatch: async (texts: string[]) => texts.map(() => null),
  generate: async () => null,
  modelExists: async (model: string) => ({ name: model, exists: false }),
  expandQuery: async () => [],
  rerank: async () => ({ results: [], model: "noop" }),
  tokenize: async (text: string) => Array.from(text).map(() => 0),
  dispose: async () => {},
  // Lifecycle/probe methods used by the old qmd status path
  getDeviceInfo: async () => ({ gpu: null, gpuOffloading: false, gpuDevices: [], vram: null, cpuCores: 0 }),
};

/** @deprecated No-op. */
export function setDefaultLlamaCpp(_llm: unknown): void { /* no-op */ }

/** @deprecated No-op. */
export async function disposeDefaultLlamaCpp(): Promise<void> { /* no-op */ }

/** @deprecated Always true (no model to unload). */
export function canUnloadLLM(): boolean { return true; }

/** @deprecated Stub — sessions are no longer scoped to a singleton. */
export async function withLLMSession<T>(_opts: unknown, fn: (session: any) => Promise<T>): Promise<T> {
  return fn(null);
}

/** @deprecated Type alias kept for backwards compat. Was LlamaCppConfig. */
export type LlamaCppConfig = Record<string, never>;
