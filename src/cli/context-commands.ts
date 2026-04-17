/**
 * cli/context-commands.ts — qmd context add/list/remove + path→collection helper.
 *
 * Extracted from cli/qmd.ts. Contexts are per-collection-path annotations
 * surfaced to the retrieval pipeline. The CLI lets users manage them by
 * either filesystem path (auto-detected to the owning collection) or by
 * `qmd://collection/path` virtual path.
 *
 * `detectCollectionFromPath` is exported because other CLI command handlers
 * (currently `getDocument` in qmd.ts) also need the same path→collection
 * lookup. It doesn't actually read the Database it accepts as an argument
 * — the `db` param is kept for API stability and in case future
 * implementations need row-level data.
 */

import { getRealPath, isVirtualPath } from "../store.js";
import {
  listCollections as yamlListCollections,
  addContext as yamlAddContext,
  removeContext as yamlRemoveContext,
  setGlobalContext,
  listAllContexts,
} from "../collections.js";
import type { Database } from "../db.js";
import { getDb, getStore, closeDb, resyncConfig } from "./db-state.js";
import { c, warn, success, info } from "./terminal.js";
import { resolveFsPath, requireValidVirtualPath } from "./command-helpers.js";

/** Walk the YAML-configured collections and find the one whose root is the
 *  longest prefix of the given filesystem path. Returns the collection name
 *  plus the sub-path within that collection (empty for exact root match). */
export function detectCollectionFromPath(
  _db: Database,
  fsPath: string,
): { collectionName: string; relativePath: string } | null {
  const realPath = getRealPath(fsPath);
  const allCollections = yamlListCollections();

  let bestMatch: { name: string; path: string } | null = null;
  for (const coll of allCollections) {
    if (realPath.startsWith(coll.path + "/") || realPath === coll.path) {
      if (!bestMatch || coll.path.length > bestMatch.path.length) {
        bestMatch = { name: coll.name, path: coll.path };
      }
    }
  }

  if (!bestMatch) return null;

  let relativePath = realPath;
  if (relativePath.startsWith(bestMatch.path + "/")) {
    relativePath = relativePath.slice(bestMatch.path.length + 1);
  } else if (relativePath === bestMatch.path) {
    relativePath = "";
  }

  return { collectionName: bestMatch.name, relativePath };
}

export async function contextAdd(pathArg: string | undefined, contextText: string): Promise<void> {
  const db = getDb();

  if (pathArg === "/") {
    setGlobalContext(contextText);
    resyncConfig();
    console.log(success("Set global context"));
    console.log(info(`Context: ${contextText}`));
    closeDb();
    return;
  }

  const fsPath = resolveFsPath(pathArg);

  if (isVirtualPath(fsPath)) {
    const parsed = requireValidVirtualPath(fsPath);
    yamlAddContext(parsed.collectionName, parsed.path, contextText);
    resyncConfig();

    const displayPath = parsed.path
      ? `qmd://${parsed.collectionName}/${parsed.path}`
      : `qmd://${parsed.collectionName}/ (collection root)`;
    console.log(success(`Added context for: ${displayPath}`));
    console.log(info(`Context: ${contextText}`));
    closeDb();
    return;
  }

  const detected = detectCollectionFromPath(db, fsPath);
  if (!detected) {
    console.error(warn(`Path is not in any indexed collection: ${fsPath}`));
    console.error(info(`Run 'qmd status' to see indexed collections`));
    process.exit(1);
  }

  yamlAddContext(detected.collectionName, detected.relativePath, contextText);
  resyncConfig();

  const displayPath = detected.relativePath
    ? `qmd://${detected.collectionName}/${detected.relativePath}`
    : `qmd://${detected.collectionName}/`;
  console.log(success(`Added context for: ${displayPath}`));
  console.log(info(`Context: ${contextText}`));
  closeDb();
}

export function contextList(): void {
  void getDb(); // Opens the store so the YAML→SQLite sync runs before listing.
  const allContexts = listAllContexts();

  if (allContexts.length === 0) {
    console.log(info("No contexts configured. Use 'qmd context add' to add one."));
    closeDb();
    return;
  }

  console.log(`\n${c.bold}Configured Contexts${c.reset}\n`);

  let lastCollection = "";
  for (const ctx of allContexts) {
    if (ctx.collection !== lastCollection) {
      console.log(`${c.cyan}${ctx.collection}${c.reset}`);
      lastCollection = ctx.collection;
    }
    const displayPath = ctx.path ? `  ${ctx.path}` : "  / (root)";
    console.log(`${displayPath}`);
    console.log(`    ${info(ctx.context)}`);
  }

  closeDb();
}

export function contextRemove(pathArg: string): void {
  if (pathArg === "/") {
    setGlobalContext(undefined);
    // Re-sync so SQLite store_config reflects the removal.
    void getStore();
    resyncConfig();
    closeDb();
    console.log(success("Removed global context"));
    return;
  }

  if (isVirtualPath(pathArg)) {
    const parsed = requireValidVirtualPath(pathArg);
    const removed = yamlRemoveContext(parsed.collectionName, parsed.path);
    if (!removed) {
      console.error(warn(`No context found for: ${pathArg}`));
      process.exit(1);
    }
    console.log(success(`Removed context for: ${pathArg}`));
    return;
  }

  const fsPath = resolveFsPath(pathArg);

  const db = getDb();
  const detected = detectCollectionFromPath(db, fsPath);
  closeDb();

  if (!detected) {
    console.error(warn(`Path is not in any indexed collection: ${fsPath}`));
    process.exit(1);
  }

  const removed = yamlRemoveContext(detected.collectionName, detected.relativePath);
  if (!removed) {
    console.error(warn(`No context found for: qmd://${detected.collectionName}/${detected.relativePath}`));
    process.exit(1);
  }

  console.log(success(`Removed context for: qmd://${detected.collectionName}/${detected.relativePath}`));
}
