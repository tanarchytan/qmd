# devnotes/

Developer notes, scratchpads, session handoffs, and pre-release context for Lotl.

These are **not** user-facing docs. User-facing material lives at:
- [`../README.md`](../README.md) — project overview + quick start
- [`../docs/EVAL.md`](../docs/EVAL.md) — how to run benchmarks
- [`../docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md) — production architecture
- [`../docs/SYNTAX.md`](../docs/SYNTAX.md) — markdown/lotl syntax reference
- [`../docs/TODO.md`](../docs/TODO.md) — live optimization tracker
- [`../docs/ROADMAP.md`](../docs/ROADMAP.md) — release history + lessons learned
- [`../evaluate/SNAPSHOTS.md`](../evaluate/SNAPSHOTS.md) — pinned benchmark results
- [`../CHANGELOG.md`](../CHANGELOG.md) — shipped-release changelog

Everything in this folder is **working-draft material**: the why-we-did-it, the
dead ends, the daily session handoffs, the half-formed ideas. Useful for
context archaeology; not canonical for users.

## Layout

```
devnotes/
├── embedders/          ← embedder A/Bs, sweep results, HF model catalog
├── metrics/            ← metric discipline (R@5 definitions, sr5 audit, etc.)
├── architecture/       ← design decisions that didn't graduate to docs/ARCHITECTURE
├── sessions/           ← date-named session handoffs, daily scratchpads
└── archive/            ← one-off scripts-prep notes, abandoned directions
```

## Conventions

- **One topic per file.** If a scratchpad drifts into two domains, split.
- **Date-named session files** use the pattern `session-YYYY-MM-DD[-slug].md`.
  Multiple sessions same day get a `-morning` / `-evening` / `-late` suffix or
  a short topic slug.
- **Don't delete old notes** — move to `archive/` if they're no longer relevant.
  Context archaeology is why this folder exists.
- **Link back to source of truth.** When a devnote's content gets promoted to
  `docs/` or `evaluate/SNAPSHOTS.md`, update the devnote to point at the new
  canonical location and mark the devnote as historical.

## Where things live

| What | Where |
|---|---|
| Embedder sweep results (current + failed candidates) | `embedders/` |
| HF model format gotchas (external-data, arch incompat, etc.) | `embedders/` |
| R@5 vs recall_any@5 vs sr5 metric discipline | `metrics/` |
| Pluggable storage design, scope partitioning, vec0 KNN | `architecture/` |
| Session handoffs (what changed this session, next-step queue) | `sessions/` |
| "Tonight I tried X and it didn't work" scratchpads | `sessions/` or `archive/` |
| Retired experiments (NPU probe, fastembed, etc.) | `archive/` |
| Plans that were never executed | `archive/` |
