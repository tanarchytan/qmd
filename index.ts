/**
 * OpenClaw plugin entry point.
 *
 * OpenClaw's loader looks for index.ts at the package root.
 * This re-exports from the actual plugin implementation.
 */
export { default } from "./src/openclaw/plugin.js";
