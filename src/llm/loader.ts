/**
 * llm/loader.ts — lazy node-llama-cpp module loader.
 *
 * Split out from src/llm.ts so other llm/ submodules (pull, local) can share
 * the same singleton without importing from llm.ts and risking circular deps.
 *
 * Lazy-loaded to avoid top-level await that would break Jiti (OpenClaw plugin loader).
 * OpenClaw installs with --ignore-scripts which skips node-llama-cpp's native build,
 * so the plugin path must never trigger this import.
 */

let _llamaMod: any = null;

export async function loadLlamaCppModule(): Promise<any> {
  if (!_llamaMod) {
    try {
      _llamaMod = await import("node-llama-cpp");
    } catch (err) {
      throw new Error(`node-llama-cpp not available. Install with: npm install node-llama-cpp\n${err}`);
    }
  }
  return _llamaMod;
}
