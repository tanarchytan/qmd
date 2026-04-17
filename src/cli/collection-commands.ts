/**
 * cli/collection-commands.ts — qmd collection list/remove/rename handlers.
 *
 * Extracted from cli/qmd.ts. Each function is a CLI command entry point:
 * parses its own DB, prints to stdout/stderr, closes the DB when done.
 *
 * Note: `qmd collection add` stays in qmd.ts for now because it's tightly
 * coupled to `indexFiles` (~140 LOC of indexing logic). Splitting the
 * indexing cluster is a later refactor slice.
 */

import {
  listCollections,
  removeCollection,
  renameCollection,
} from "../store.js";
import {
  getCollection as getCollectionFromYaml,
  removeCollection as yamlRemoveCollectionFn,
  renameCollection as yamlRenameCollectionFn,
} from "../collections.js";
import { getDb, closeDb } from "./db-state.js";
import { c } from "./terminal.js";
import { formatTimeAgo } from "./format.js";

export function collectionList(): void {
  const db = getDb();
  const collections = listCollections(db);

  if (collections.length === 0) {
    console.log("No collections found. Run 'qmd collection add .' to create one.");
    closeDb();
    return;
  }

  console.log(`${c.bold}Collections (${collections.length}):${c.reset}\n`);

  for (const coll of collections) {
    const updatedAt = coll.last_modified ? new Date(coll.last_modified) : new Date();
    const timeAgo = formatTimeAgo(updatedAt);

    const yamlColl = getCollectionFromYaml(coll.name);
    const excluded = yamlColl?.includeByDefault === false;
    const excludeTag = excluded ? ` ${c.yellow}[excluded]${c.reset}` : "";

    console.log(`${c.cyan}${coll.name}${c.reset} ${c.dim}(qmd://${coll.name}/)${c.reset}${excludeTag}`);
    console.log(`  ${c.dim}Pattern:${c.reset}  ${coll.glob_pattern}`);
    if (yamlColl?.ignore?.length) {
      console.log(`  ${c.dim}Ignore:${c.reset}   ${yamlColl.ignore.join(", ")}`);
    }
    console.log(`  ${c.dim}Files:${c.reset}    ${coll.active_count}`);
    console.log(`  ${c.dim}Updated:${c.reset}  ${timeAgo}`);
    console.log();
  }

  closeDb();
}

export function collectionRemove(name: string): void {
  const coll = getCollectionFromYaml(name);
  if (!coll) {
    console.error(`${c.yellow}Collection not found: ${name}${c.reset}`);
    console.error(`Run 'qmd collection list' to see available collections.`);
    process.exit(1);
  }

  const db = getDb();
  const result = removeCollection(db, name);
  yamlRemoveCollectionFn(name);
  closeDb();

  console.log(`${c.green}✓${c.reset} Removed collection '${name}'`);
  console.log(`  Deleted ${result.deletedDocs} documents`);
  if (result.cleanedHashes > 0) {
    console.log(`  Cleaned up ${result.cleanedHashes} orphaned content hashes`);
  }
}

export function collectionRename(oldName: string, newName: string): void {
  const coll = getCollectionFromYaml(oldName);
  if (!coll) {
    console.error(`${c.yellow}Collection not found: ${oldName}${c.reset}`);
    console.error(`Run 'qmd collection list' to see available collections.`);
    process.exit(1);
  }

  const existing = getCollectionFromYaml(newName);
  if (existing) {
    console.error(`${c.yellow}Collection name already exists: ${newName}${c.reset}`);
    console.error(`Choose a different name or remove the existing collection first.`);
    process.exit(1);
  }

  const db = getDb();
  renameCollection(db, oldName, newName);
  yamlRenameCollectionFn(oldName, newName);
  closeDb();

  console.log(`${c.green}✓${c.reset} Renamed collection '${oldName}' to '${newName}'`);
  console.log(`  Virtual paths updated: ${c.cyan}qmd://${oldName}/${c.reset} → ${c.cyan}qmd://${newName}/${c.reset}`);
}
