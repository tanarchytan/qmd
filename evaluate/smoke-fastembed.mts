// Smoke test for src/llm/fastembed.ts — verifies that the fastembed
// backend loads, downloads the MiniLM model on first use, and produces
// deterministic 384-dim vectors. Run with:
//
//   npx tsx evaluate/smoke-fastembed.mts
import { createFastEmbedBackend } from "../src/llm/fastembed.js";

async function main() {
  console.log("Loading fastembed AllMiniLML6V2 (may download ~80 MB on first use)...");
  const backend = await createFastEmbedBackend();
  console.log("Loaded.");

  const probes = [
    "Caroline moved to Portland in March 2023.",
    "Melanie enjoys painting sunrises.",
    "The meeting is on Friday at 3pm.",
  ];
  console.log("\nBatch embed:");
  const batch = await backend.embedBatch(probes);
  for (let i = 0; i < batch.length; i++) {
    const r = batch[i];
    console.log(`  [${i}] dim=${r?.embedding.length ?? 0}  norm=${r ? Math.hypot(...r.embedding).toFixed(4) : "n/a"}  head=[${r?.embedding.slice(0, 3).map(x => x.toFixed(3)).join(", ")}...]`);
  }

  console.log("\nDeterminism check (same input, two passes):");
  const a = await backend.embed(probes[0]!);
  const b = await backend.embed(probes[0]!);
  const same = JSON.stringify(a?.embedding) === JSON.stringify(b?.embedding);
  console.log(`  ${same ? "PASS" : "FAIL"} — identical: ${same}`);

  console.log("\nCosine similarity between 'Caroline moved to Portland' and 'Caroline went to Oregon':");
  const va = await backend.embed("Caroline moved to Portland in March 2023.");
  const vb = await backend.embed("Caroline went to Oregon last year.");
  if (va && vb) {
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < va.embedding.length; i++) {
      dot += va.embedding[i]! * vb.embedding[i]!;
      na += va.embedding[i]! ** 2;
      nb += vb.embedding[i]! ** 2;
    }
    const cos = dot / (Math.sqrt(na) * Math.sqrt(nb));
    console.log(`  cosine = ${cos.toFixed(4)}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
