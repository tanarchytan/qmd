#!/usr/bin/env bash
# Build a container image with lotl installed via npm, then run smoke tests.
# Works with docker or podman (whichever is available).
#
# Usage:
#   test/smoke/install.sh              # build + run all smoke tests
#   test/smoke/install.sh --build      # build image only
#   test/smoke/install.sh --shell      # drop into container shell
#   test/smoke/install.sh -- CMD...    # run arbitrary command in container
set -euo pipefail

cd "$(dirname "$0")/../.."

if command -v podman &>/dev/null; then
  CTR=podman
elif command -v docker &>/dev/null; then
  CTR=docker
else
  echo "Error: neither podman nor docker found" >&2
  exit 1
fi

IMAGE=lotl-smoke
SMOKE_DIR="test/smoke"

build_image() {
  echo "==> Building TypeScript..."
  npm run build --silent

  echo "==> Packing tarball..."
  rm -f "$SMOKE_DIR"/tanarchy-lotl-*.tgz
  TARBALL=$(npm pack --pack-destination "$SMOKE_DIR" 2>/dev/null | tail -1)
  echo "    $TARBALL"

  # Copy project files into build context so vitest can run inside the container
  rm -rf "$SMOKE_DIR/test-src"
  mkdir -p "$SMOKE_DIR/test-src/src" "$SMOKE_DIR/test-src/test"
  cp -r src/* "$SMOKE_DIR/test-src/src/"
  cp -r dist "$SMOKE_DIR/test-src/"
  cp test/*.test.ts "$SMOKE_DIR/test-src/test/"
  cp package.json tsconfig.json tsconfig.build.json "$SMOKE_DIR/test-src/"

  echo "==> Building container image ($CTR)..."
  $CTR build -f "$SMOKE_DIR/Containerfile" -t "$IMAGE" "$SMOKE_DIR/"

  rm -f "$SMOKE_DIR"/tanarchy-lotl-*.tgz
  rm -rf "$SMOKE_DIR/test-src"
  echo "==> Image ready: $IMAGE"
}

run() {
  $CTR run --rm "$IMAGE" bash -c "$*"
}

PASS=0
FAIL=0

ok()   { printf "  %-50s OK\n" "$1"; PASS=$((PASS + 1)); }
fail() { printf "  %-50s FAIL\n" "$1"; FAIL=$((FAIL + 1)); echo "$2" | sed 's/^/    /'; }

smoke_test() {
  local label="$1"; shift
  local out
  if out=$(run "$@" 2>&1); then
    ok "$label"
  else
    fail "$label" "$out"
  fi
}

smoke_test_output() {
  local label="$1"; local expect="$2"; shift 2
  local out
  out=$(run "$@" 2>&1) || true
  if echo "$out" | grep -q "$expect"; then
    ok "$label"
  else
    fail "$label" "$out"
  fi
}

run_smoke_tests() {
  local NODE_BIN='$(mise where node@latest)/bin'
  echo "=== Node (npm install) ==="

  smoke_test_output "lotl shows help" "Usage:" \
    "export PATH=$NODE_BIN:\$PATH; lotl"

  smoke_test_output "qmd alias shows help" "Usage:" \
    "export PATH=$NODE_BIN:\$PATH; qmd"

  smoke_test "lotl collection list" \
    "export PATH=$NODE_BIN:\$PATH; lotl collection list"

  smoke_test "lotl status" \
    "export PATH=$NODE_BIN:\$PATH; lotl status"

  smoke_test "sqlite-vec loads" \
    "export PATH=$NODE_BIN:\$PATH;
     NPM_GLOBAL=\$(npm root -g);
     node -e \"
      const {openDatabase, loadSqliteVec} = await import('\$NPM_GLOBAL/@tanarchy/lotl/dist/db.js');
      const db = openDatabase(':memory:');
      loadSqliteVec(db);
      const r = db.prepare('SELECT vec_version() as v').get();
      console.log('sqlite-vec', r.v);
      if (!r.v) process.exit(1);
    \""

  smoke_test "vitest store.test.ts" \
    "export PATH=$NODE_BIN:\$PATH; cd /opt/lotl && npx vitest run --reporter=verbose test/store.test.ts 2>&1 | tail -5"

  echo ""
  echo "=== Results: $PASS passed, $FAIL failed ==="
  [[ $FAIL -eq 0 ]]
}

case "${1:-}" in
  --build)
    build_image
    ;;
  --shell)
    build_image
    echo "==> Dropping into container shell..."
    $CTR run --rm -it "$IMAGE" bash
    ;;
  --)
    shift
    run "$@"
    ;;
  *)
    build_image
    echo ""
    echo "==> Running smoke tests..."
    run_smoke_tests
    ;;
esac
