# test/smoke/ — install smoke tests

Non-vitest smoke tests for container-based install verification.
These run outside the main vitest suite — use before publishing a release
to validate the npm install story end-to-end.

| File | Purpose |
|---|---|
| `Containerfile` | Debian-slim image with Node + globally-installed lotl |
| `install.sh` | Pack + build image + run CLI + sqlite-vec + vitest smoke tests |

**Bun was dropped at v1.0.0.** Node ≥22 is the only supported runtime.

## Running

```sh
# Full run: pack, build image, run smoke tests
test/smoke/install.sh

# Image only (inspect manually afterwards)
test/smoke/install.sh --build

# Drop into container shell
test/smoke/install.sh --shell

# Run arbitrary command inside the image
test/smoke/install.sh -- lotl status
```

The main `*.test.ts` files at `test/` root remain the canonical vitest suite.
