#!/usr/bin/env node
// Extended sanity probe: new small-class candidates + quantized variants
// of MiniLM-L6-v2 and mxbai-embed-xsmall-v1 (apples-to-apples backend).

import { createTransformersEmbedBackend } from "../dist/src/llm/transformers-embed.js";

// [tag, modelId, dtype, fileName?]  — fileName omits .onnx suffix
const MODELS = [
  // New candidates
  ["e5-small-v2 (O4)",            "intfloat/e5-small-v2",                    "fp32", "model_O4"],
  ["e5-small-v2 (int8)",          "intfloat/e5-small-v2",                    "fp32", "model_qint8_avx512_vnni"],
  ["multilingual-e5-small (fp32)","intfloat/multilingual-e5-small",          "fp32", undefined],
  ["multilingual-e5-small (int8)","intfloat/multilingual-e5-small",          "fp32", "model_qint8_avx512_vnni"],
  ["all-MiniLM-L12-v2 (fp32)",    "sentence-transformers/all-MiniLM-L12-v2", "fp32", undefined],
  ["all-MiniLM-L12-v2 (int8)",    "sentence-transformers/all-MiniLM-L12-v2", "fp32", "model_qint8_avx512_vnni"],

  // MiniLM-L6-v2 quantized variants (apples-to-apples)
  ["all-MiniLM-L6-v2 (fp32)",     "sentence-transformers/all-MiniLM-L6-v2",  "fp32", undefined],
  ["all-MiniLM-L6-v2 (O4)",       "sentence-transformers/all-MiniLM-L6-v2",  "fp32", "model_O4"],
  ["all-MiniLM-L6-v2 (int8)",     "sentence-transformers/all-MiniLM-L6-v2",  "fp32", "model_qint8_avx512_vnni"],
  ["all-MiniLM-L6-v2 (uint8)",    "sentence-transformers/all-MiniLM-L6-v2",  "fp32", "model_quint8_avx2"],

  // mxbai-embed-xsmall-v1 quantized variants
  ["mxbai-xs (fp32)",             "mixedbread-ai/mxbai-embed-xsmall-v1",     "fp32", undefined],
  ["mxbai-xs (fp16)",             "mixedbread-ai/mxbai-embed-xsmall-v1",     "fp16", undefined],
  ["mxbai-xs (q8)",               "mixedbread-ai/mxbai-embed-xsmall-v1",     "q8",   undefined],
  ["mxbai-xs (int8)",             "mixedbread-ai/mxbai-embed-xsmall-v1",     "fp32", "model_int8"],
  ["mxbai-xs (q4)",               "mixedbread-ai/mxbai-embed-xsmall-v1",     "q4",   undefined],
];

const A = "The quick brown fox jumps over the lazy dog.";
const B = "A fast russet fox leaps above a sleeping canine.";
const C = "Nuclear reactor coolant flow calibration.";

function cosine(x, y) {
  let dot = 0, nx = 0, ny = 0;
  for (let i = 0; i < x.length; i++) { dot += x[i]*y[i]; nx += x[i]*x[i]; ny += y[i]*y[i]; }
  return dot / (Math.sqrt(nx) * Math.sqrt(ny) || 1);
}

for (const [tag, modelId, dtype, fileName] of MODELS) {
  console.log(`\n=== ${tag} ===`);
  console.log(`  modelId: ${modelId}  dtype: ${dtype}${fileName ? `  file: ${fileName}` : ""}`);
  const t0 = Date.now();
  try {
    const be = await createTransformersEmbedBackend(modelId, dtype, fileName);
    const r1 = await be.embed(A);
    const r1b = await be.embed(A);
    const r2 = await be.embed(B);
    const r3 = await be.embed(C);
    const loadMs = Date.now() - t0;
    if (!r1 || !r2 || !r3) { console.log("  FAIL: null embedding"); await be.dispose(); continue; }
    const dim = r1.embedding.length;
    const selfCos = cosine(r1.embedding, r1b.embedding);
    const nearCos = cosine(r1.embedding, r2.embedding);
    const farCos = cosine(r1.embedding, r3.embedding);
    console.log(`  dim:       ${dim}`);
    console.log(`  self-cos:  ${selfCos.toFixed(4)}`);
    console.log(`  near-cos:  ${nearCos.toFixed(4)}`);
    console.log(`  far-cos:   ${farCos.toFixed(4)}`);
    console.log(`  spread:    ${(nearCos - farCos).toFixed(4)}`);
    console.log(`  load+4emb: ${loadMs}ms`);
    const healthy = selfCos > 0.999 && nearCos > farCos;
    console.log(`  verdict:   ${healthy ? "HEALTHY" : "SUSPECT"}`);
    await be.dispose();
  } catch (err) {
    console.log(`  FAIL: ${err instanceof Error ? err.message : err}`);
  }
}
