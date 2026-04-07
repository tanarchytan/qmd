/**
 * remote-config.ts - Build RemoteLLMConfig from environment variables.
 *
 * Each operation reads 4 vars:
 *   QMD_{OP}_PROVIDER=  local | api | url | gemini
 *   QMD_{OP}_API_KEY=   Bearer token
 *   QMD_{OP}_URL=       base URL (api/gemini) or full endpoint (url)
 *   QMD_{OP}_MODEL=     model name
 *
 * Shorthand aliases (set provider + default URL automatically):
 *   siliconflow → api  + https://api.siliconflow.cn/v1
 *   openai      → api  + https://api.openai.com/v1
 *   zeroentropy → url  + operation-specific ZE endpoint
 *   dashscope   → url  + https://dashscope.aliyuncs.com/compatible-api/v1/reranks
 *   gemini      → gemini + https://generativelanguage.googleapis.com
 */

import type { RemoteLLMConfig, OperationConfig, OperationProvider } from "./llm.js";

type OpName = 'EMBED' | 'RERANK' | 'QUERY_EXPANSION';

const ZE_DEFAULT_URLS: Record<OpName, string> = {
  EMBED: "https://api.zeroentropy.dev/v1/models/embed",
  RERANK: "https://api.zeroentropy.dev/v1/models/rerank",
  QUERY_EXPANSION: "https://api.zeroentropy.dev/v1/chat/completions",
};

function resolveOp(op: OpName): OperationConfig | null {
  const providerRaw = process.env[`QMD_${op}_PROVIDER`];
  if (!providerRaw || providerRaw === 'local') return null;

  const apiKey = process.env[`QMD_${op}_API_KEY`];
  if (!apiKey) return null;

  let url = process.env[`QMD_${op}_URL`];
  const model = process.env[`QMD_${op}_MODEL`];
  let resolvedProvider: OperationProvider;

  switch (providerRaw) {
    case 'siliconflow':
      resolvedProvider = 'api';
      url ??= 'https://api.siliconflow.cn/v1';
      break;
    case 'openai':
      resolvedProvider = 'api';
      url ??= 'https://api.openai.com/v1';
      break;
    case 'zeroentropy':
      resolvedProvider = 'url';
      url ??= ZE_DEFAULT_URLS[op];
      break;
    case 'dashscope':
      resolvedProvider = 'url';
      url ??= 'https://dashscope.aliyuncs.com/compatible-api/v1/reranks';
      break;
    case 'gemini':
      resolvedProvider = 'gemini';
      url ??= 'https://generativelanguage.googleapis.com';
      break;
    case 'api':
      resolvedProvider = 'api';
      break;
    case 'url':
      resolvedProvider = 'url';
      break;
    default:
      resolvedProvider = 'api';
  }

  const cfg: OperationConfig = { provider: resolvedProvider, apiKey };
  if (url) cfg.url = url;
  if (model) cfg.model = model;
  return cfg;
}

export function createRemoteConfigFromEnv(): RemoteLLMConfig | null {
  const embed = resolveOp('EMBED');
  const rerank = resolveOp('RERANK');
  const queryExpansion = resolveOp('QUERY_EXPANSION');

  if (!embed && !rerank && !queryExpansion) return null;

  const config: RemoteLLMConfig = {};

  if (embed) {
    const dimRaw = process.env.QMD_EMBED_DIMENSIONS;
    const dimNum = dimRaw ? parseInt(dimRaw, 10) : undefined;
    const validDims = [4096, 2048, 2560, 1280, 640, 320, 160, 80, 40] as const;
    type ValidDim = typeof validDims[number];
    config.embed = {
      ...embed,
      dimensions: (validDims as readonly number[]).includes(dimNum ?? -1) ? dimNum as ValidDim : undefined,
    };
  }

  if (rerank) {
    // 'url' provider targets a dedicated rerank API endpoint — default to 'rerank' mode.
    // 'api' and 'gemini' default to 'llm' mode. QMD_RERANK_MODE always wins if set.
    const defaultMode = rerank.provider === 'url' ? 'rerank' : 'llm';
    const rerankMode = (process.env.QMD_RERANK_MODE as 'llm' | 'rerank' | undefined) || defaultMode;
    config.rerank = { ...rerank, mode: rerankMode };
  }

  if (queryExpansion) {
    config.queryExpansion = queryExpansion;
  }

  return config;
}
