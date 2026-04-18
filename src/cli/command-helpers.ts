/**
 * cli/command-helpers.ts — shared precondition + path-resolution helpers.
 *
 * Extracted from duplicated patterns in context-commands.ts and
 * collection-commands.ts. All helpers here **may `process.exit(1)`** on
 * validation failure — they're CLI-layer conveniences, not library code.
 * Library callers should go straight to `parseVirtualPath` / YAML accessors
 * and handle errors themselves.
 */

import { parseVirtualPath, getPwd, homedir, resolve } from "../store.js";
import { getCollection as getCollectionFromYaml } from "../collections.js";
import { c } from "./terminal.js";

// Local alias — mirrors the shape returned by parseVirtualPath. Tied to the
// non-null branch so callers can use the result without a null check.
type ParsedVirtualPath = NonNullable<ReturnType<typeof parseVirtualPath>>;

/** Normalize a user-supplied path argument to an absolute filesystem path.
 *  - No arg or ".": current working directory
 *  - "~/..." → expanded against homedir
 *  - relative path → resolved against pwd
 *  - already absolute or lotl:// → returned as-is
 */
export function resolveFsPath(pathArg: string | undefined): string {
  let fsPath = pathArg || ".";
  if (fsPath === "." || fsPath === "./") {
    return getPwd();
  }
  if (fsPath.startsWith("~/")) {
    return homedir() + fsPath.slice(1);
  }
  if (!fsPath.startsWith("/") && !fsPath.startsWith("lotl://")) {
    return resolve(getPwd(), fsPath);
  }
  return fsPath;
}

/** Parse a `lotl://<collection>/<path>` virtual path and verify the collection
 *  exists. Exits with a yellow-tagged error on either malformed URI or unknown
 *  collection. Returns the parsed result on success. */
export function requireValidVirtualPath(pathArg: string): ParsedVirtualPath {
  const parsed = parseVirtualPath(pathArg);
  if (!parsed) {
    console.error(`${c.yellow}Invalid virtual path: ${pathArg}${c.reset}`);
    process.exit(1);
  }
  const coll = getCollectionFromYaml(parsed.collectionName);
  if (!coll) {
    console.error(`${c.yellow}Collection not found: ${parsed.collectionName}${c.reset}`);
    process.exit(1);
  }
  return parsed;
}

/** Look up a collection by name in YAML config. Exits with a yellow-tagged
 *  error + "run qmd collection list" hint if it doesn't exist. */
export function requireCollectionOrExit(name: string): ReturnType<typeof getCollectionFromYaml> & {} {
  const coll = getCollectionFromYaml(name);
  if (!coll) {
    console.error(`${c.yellow}Collection not found: ${name}${c.reset}`);
    console.error(`Run 'lotl collection list' to see available collections.`);
    process.exit(1);
  }
  return coll;
}
