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
