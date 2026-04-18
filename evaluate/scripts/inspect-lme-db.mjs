import Database from "better-sqlite3";
const db = new Database(process.argv[2] || "./evaluate/longmemeval/dbs/lme-s.sqlite", { readonly: true });
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
console.log("tables:", tables);

const tot = db.prepare("SELECT COUNT(*) c FROM memories").get();
const scopeCount = db.prepare("SELECT COUNT(DISTINCT scope) c FROM memories").get();
console.log(`total memories: ${tot.c}, distinct scopes: ${scopeCount.c}`);

const top = db.prepare("SELECT scope, COUNT(*) c FROM memories GROUP BY scope ORDER BY c DESC LIMIT 5").all();
console.log("highest:", top);

const low = db.prepare("SELECT scope, COUNT(*) c FROM memories GROUP BY scope ORDER BY c ASC LIMIT 5").all();
console.log("lowest:", low);

try {
  const vec = db.prepare("SELECT COUNT(*) c FROM memories_vec").get();
  console.log("vec rows:", vec.c);
} catch (e) {
  console.log("vec error:", e.message);
}

// Sample question_id scope and look at its memories
const sampleScope = top[0]?.scope;
if (sampleScope) {
  const sample = db.prepare("SELECT id, length(text) AS tlen, importance FROM memories WHERE scope = ? LIMIT 3").all(sampleScope);
  console.log(`sample memories from scope=${sampleScope}:`, sample);
}
