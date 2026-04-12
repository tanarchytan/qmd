/**
 * llm.ts — Facade for the LLM abstraction layer.
 *
 * Real implementations live under src/llm/:
 *   - loader.ts    lazy node-llama-cpp module loader
 *   - types.ts     LLM + ILLMSession interfaces, default model URIs, format helpers
 *   - pull.ts      HF model-pull utilities
 *   - local.ts     LlamaCpp class + default-singleton session coordination
 *   - remote.ts    RemoteLLM cloud-provider implementation
 *   - session.ts   LLMSessionManager / LLMSession generic session machinery
 *
 * This file is kept for backwards compatibility — every historical
 * `import ... from "./llm.js"` resolves here and forwards to the right
 * submodule. New code should import from the submodules directly.
 */

// Model pull utilities (src/llm/pull.ts)
export { pullModels, DEFAULT_MODEL_CACHE_DIR } from "./llm/pull.js";
export type { PullResult } from "./llm/pull.js";

// Shared types, default URIs, and embedding format helpers (src/llm/types.ts)
export {
  DEFAULT_EMBED_MODEL,
  DEFAULT_RERANK_MODEL,
  DEFAULT_GENERATE_MODEL,
  DEFAULT_EMBED_MODEL_URI,
  DEFAULT_RERANK_MODEL_URI,
  DEFAULT_GENERATE_MODEL_URI,
  LFM2_GENERATE_MODEL,
  LFM2_INSTRUCT_MODEL,
  isQwen3EmbeddingModel,
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

// Local (LlamaCpp) implementation + default-singleton session coordination
// (src/llm/local.ts)
export {
  LlamaCpp,
  isLocalEnabled,
  getDefaultLlamaCpp,
  setDefaultLlamaCpp,
  disposeDefaultLlamaCpp,
  withLLMSession,
  canUnloadLLM,
} from "./llm/local.js";
export type { LlamaCppConfig } from "./llm/local.js";

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
