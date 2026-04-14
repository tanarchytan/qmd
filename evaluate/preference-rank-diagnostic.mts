/**
 * preference-rank-diagnostic.mts
 *
 * For each single-session-preference question, embed the query with mxbai-xs q8
 * and run a NO-CUTOFF vector search against the question's scope in the eval
 * memories DB. Report where the correct answer_session_id actually ranks.
 *
 * Answers the v17 root-cause question (ROADMAP §"v17 priority shift" item 1):
 * "Are we missing the right preference session, or returning it in the wrong order?"
 *
 * Run from ~/qmd-eval/ on WSL:
 *   QMD_TRANSFORMERS_EMBED=mixedbread-ai/mxbai-embed-xsmall-v1 \
 *   QMD_TRANSFORMERS_DTYPE=q8 \
 *   npx tsx evaluate/preference-rank-diagnostic.mts
 *
 * Reads:
 *   - evaluate/longmemeval/longmemeval_s_cleaned.json
 *   - evaluate/longmemeval/dbs/lme-s.sqlite
 */

import Database from "better-sqlite3";
import { readFileSync } from "fs";
import { createTransformersEmbedBackend } from "../src/llm/transformers-embed.js";
import * as sqliteVec from "sqlite-vec";

const DB_PATH = "evaluate/longmemeval/dbs/lme-s.sqlite";
const DATASET_PATH = "evaluate/longmemeval/longmemeval_s_cleaned.json";

interface LmeQuestion {
  question_id: string;
  question: string;
  question_type: string;
  answer: string;
  answer_session_ids: string[];
}

const dataset: LmeQuestion[] = JSON.parse(readFileSync(DATASET_PATH, "utf8"));
const prefs = dataset.filter(q => q.question_type === "single-session-preference");
console.log(`Loaded ${prefs.length} single-session-preference questions`);

const db = new Database(DB_PATH, { readonly: true });
sqliteVec.load(db);

const embedder = await createTransformersEmbedBackend();
console.log(`Embedder ready: ${(embedder as any).embedModelName ?? "unknown"}`);

// Per-scope KNN — sqlite-vec supports `WHERE scope = ?` partition filtering
// because the table was created with `scope TEXT PARTITION KEY`.
const knnStmt = db.prepare(`
  SELECT m.id, m.metadata, v.distance
  FROM memories_vec v
  JOIN memories m ON m.id = v.id
  WHERE v.scope = ? AND v.embedding MATCH ? AND v.k = ?
  ORDER BY v.distance ASC
`);

interface RankRow {
  qid: string;
  question: string;
  correct: string[];
  candPoolSize: number;
  rankFirstHit: number | null;     // 1-indexed rank among returned candidates
  topSessions: string[];           // first 5 unique session ids in result order
  totalInScope: number;
}

const buckets = {
  "rank 1": 0,
  "rank 2-5": 0,
  "rank 6-20": 0,
  "rank 21-50": 0,
  "rank 51+": 0,
  "not in pool": 0,
};

const rows: RankRow[] = [];

for (const q of prefs) {
  const totalInScope = (db.prepare(
    `SELECT COUNT(*) AS n FROM memories WHERE scope = ?`
  ).get(q.question_id) as any).n as number;

  const emb = await embedder.embed(q.question);
  if (!emb) { console.warn(`  skip ${q.question_id}: embed failed`); continue; }
  const vec = new Float32Array(emb.embedding);

  // No-cutoff: pull every memory in the scope as a candidate.
  // sqlite-vec needs a finite k, so use totalInScope as the k value.
  const k = Math.max(totalInScope, 1);
  const cands = knnStmt.all(q.question_id, vec, k) as Array<{
    id: string; metadata: string; distance: number;
  }>;

  const correct = new Set(q.answer_session_ids ?? []);
  let rankFirstHit: number | null = null;
  const seenSessions = new Set<string>();
  const topSessions: string[] = [];
  for (let i = 0; i < cands.length; i++) {
    const meta = cands[i].metadata ? JSON.parse(cands[i].metadata) : {};
    const sid = meta.source_session_id as string | undefined;
    if (!sid) continue;
    if (!seenSessions.has(sid)) {
      seenSessions.add(sid);
      if (topSessions.length < 5) topSessions.push(sid);
    }
    if (rankFirstHit === null && correct.has(sid)) {
      rankFirstHit = i + 1;
    }
  }

  rows.push({
    qid: q.question_id,
    question: q.question.slice(0, 100),
    correct: [...correct],
    candPoolSize: cands.length,
    rankFirstHit,
    topSessions,
    totalInScope,
  });

  if (rankFirstHit === null) buckets["not in pool"]++;
  else if (rankFirstHit === 1) buckets["rank 1"]++;
  else if (rankFirstHit <= 5) buckets["rank 2-5"]++;
  else if (rankFirstHit <= 20) buckets["rank 6-20"]++;
  else if (rankFirstHit <= 50) buckets["rank 21-50"]++;
  else buckets["rank 51+"]++;
}

console.log("\n=== Per-question rank of correct preference session ===\n");
for (const r of rows) {
  const tag = r.rankFirstHit === null ? "MISS" : `rank=${r.rankFirstHit}/${r.candPoolSize}`;
  const hit5 = r.rankFirstHit !== null && r.rankFirstHit <= 5 ? "✓" : "✗";
  console.log(`${hit5} ${r.qid}  ${tag}  pool=${r.totalInScope}`);
  console.log(`   q: ${r.question}`);
  console.log(`   correct: ${r.correct.join(", ")}`);
  console.log(`   top5: ${r.topSessions.join(", ")}`);
}

console.log("\n=== Distribution ===");
for (const [k, v] of Object.entries(buckets)) {
  console.log(`  ${k.padEnd(15)}: ${v}`);
}

const inPool = rows.filter(r => r.rankFirstHit !== null).length;
const top5 = rows.filter(r => r.rankFirstHit !== null && r.rankFirstHit <= 5).length;
console.log(`\nIn pool at all: ${inPool}/${rows.length}`);
console.log(`In top-5 (sr5):  ${top5}/${rows.length}  (${(top5/rows.length*100).toFixed(1)}%)`);

await embedder.dispose();
db.close();
