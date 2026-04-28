/**
 * cli/collection-commands.ts — lotl collection list/remove/rename handlers.
 *
 * Extracted from cli/lotl.ts. Each function is a CLI command entry point:
 * parses its own DB, prints to stdout/stderr, closes the DB when done.
 *
 * Note: `lotl collection add` stays in lotl.ts for now because it's tightly
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
import { c, warn, success, info } from "./terminal.js";
import { formatTimeAgo } from "./format.js";
import { requireCollectionOrExit } from "./command-helpers.js";

export function collectionList(): void {
  const db = getDb();
  const collections = listCollections(db);

  if (collections.length === 0) {
    console.log("No collections found. Run 'lotl collection add .' to create one.");
    closeDb();
    return;
  }

  console.log(`${c.bold}Collections (${collections.length}):${c.reset}\n`);

  for (const coll of collections) {
    const updatedAt = coll.last_modified ? new Date(coll.last_modified) : new Date();
    const timeAgo = formatTimeAgo(updatedAt);

    const yamlColl = getCollectionFromYaml(coll.name);
    const excluded = yamlColl?.includeByDefault === false;
    const excludeTag = excluded ? ` ${warn("[excluded]")}` : "";

    console.log(`${c.cyan}${coll.name}${c.reset} ${info(`(lotl://${coll.name}/)`)}${excludeTag}`);
    console.log(`  ${info("Pattern:")}  ${coll.glob_pattern}`);
    if (yamlColl?.ignore?.length) {
      console.log(`  ${info("Ignore:")}   ${yamlColl.ignore.join(", ")}`);
    }
    console.log(`  ${info("Files:")}    ${coll.active_count}`);
    console.log(`  ${info("Updated:")}  ${timeAgo}`);
    console.log();
  }

  closeDb();
}

export function collectionRemove(name: string): void {
  requireCollectionOrExit(name);

  const db = getDb();
  const result = removeCollection(db, name);
  yamlRemoveCollectionFn(name);
  closeDb();

  console.log(success(`Removed collection '${name}'`));
  console.log(`  Deleted ${result.deletedDocs} documents`);
  if (result.cleanedHashes > 0) {
    console.log(`  Cleaned up ${result.cleanedHashes} orphaned content hashes`);
  }
}

export function collectionRename(oldName: string, newName: string): void {
  requireCollectionOrExit(oldName);

  const existing = getCollectionFromYaml(newName);
  if (existing) {
    console.error(warn(`Collection name already exists: ${newName}`));
    console.error(`Choose a different name or remove the existing collection first.`);
    process.exit(1);
  }

  const db = getDb();
  renameCollection(db, oldName, newName);
  yamlRenameCollectionFn(oldName, newName);
  closeDb();

  console.log(success(`Renamed collection '${oldName}' to '${newName}'`));
  console.log(`  Virtual paths updated: ${c.cyan}lotl://${oldName}/${c.reset} → ${c.cyan}lotl://${newName}/${c.reset}`);
}
