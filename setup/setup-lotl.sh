#!/usr/bin/env bash
# setup-lotl.sh — One-click installer for QMD (Search + Memory + Knowledge Graph)
# Usage: curl -fsSL https://raw.githubusercontent.com/tanarchytan/lotl/dev/setup/setup-lotl.sh | bash
#   or:  bash setup-lotl.sh [--dry-run] [--uninstall] [--provider <name>] [--local]
set -euo pipefail

VERSION="1.0.0"
PACKAGE="@tanarchy/lotl@dev"
PLUGIN_ID="tanarchy-lotl"

# Colors
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'

info()  { printf "${BLUE}[lotl]${NC} %s\n" "$*"; }
ok()    { printf "${GREEN}[lotl]${NC} %s\n" "$*"; }
warn()  { printf "${YELLOW}[lotl]${NC} %s\n" "$*"; }
err()   { printf "${RED}[lotl]${NC} %s\n" "$*" >&2; }

# =============================================================================
# Flags
# =============================================================================

DRY_RUN=false
UNINSTALL=false
PROVIDER=""
LOCAL_ONLY=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)    DRY_RUN=true; shift ;;
    --uninstall)  UNINSTALL=true; shift ;;
    --provider)   PROVIDER="$2"; shift 2 ;;
    --local)      LOCAL_ONLY=true; shift ;;
    --help|-h)
      echo "setup-lotl.sh v${VERSION} — QMD installer"
      echo ""
      echo "Usage: bash setup-lotl.sh [options]"
      echo ""
      echo "Options:"
      echo "  --dry-run         Preview actions without making changes"
      echo "  --uninstall       Remove QMD plugin and config"
      echo "  --provider NAME   Skip provider selection (siliconflow|nebius|openai|local)"
      echo "  --local           Use local models only (no API keys, needs cmake/GPU)"
      echo "  --help            Show this help"
      exit 0
      ;;
    *) err "Unknown option: $1"; exit 1 ;;
  esac
done

# =============================================================================
# Preflight
# =============================================================================

info "QMD Setup v${VERSION}"

# Check Node.js
if ! command -v node &>/dev/null; then
  err "Node.js not found. Install Node.js 22+ first: https://nodejs.org"
  exit 1
fi

NODE_VERSION=$(node -e "console.log(process.versions.node.split('.')[0])")
if [[ "$NODE_VERSION" -lt 22 ]]; then
  err "Node.js $NODE_VERSION found, but QMD requires Node.js 22+."
  err "Please upgrade: https://nodejs.org"
  exit 1
fi
ok "Node.js v$(node -v | tr -d 'v') ✓"

# Detect OpenClaw
HAS_OPENCLAW=false
OPENCLAW_JSON=""
if command -v openclaw &>/dev/null; then
  HAS_OPENCLAW=true
  # Find openclaw.json
  OPENCLAW_HOME="${OPENCLAW_HOME:-${HOME}/.openclaw}"
  OPENCLAW_JSON="${OPENCLAW_HOME}/openclaw.json"
  ok "OpenClaw detected ✓"
else
  info "OpenClaw not detected — will configure for standalone CLI/MCP use"
fi

# Detect existing QMD
HAS_QMD=false
if command -v lotl &>/dev/null; then
  HAS_QMD=true
  ok "QMD already installed: $(lotl --version 2>/dev/null || echo 'unknown version')"
fi

# =============================================================================
# Uninstall
# =============================================================================

if $UNINSTALL; then
  info "Uninstalling QMD..."
  if $DRY_RUN; then
    info "[dry-run] Would remove QMD plugin and config"
    exit 0
  fi

  if $HAS_OPENCLAW; then
    openclaw plugins uninstall "$PLUGIN_ID" 2>/dev/null || true
    info "Removed OpenClaw plugin entry"
  fi
  npm uninstall -g @tanarchy/lotl 2>/dev/null || true
  ok "QMD uninstalled"
  exit 0
fi

# =============================================================================
# Install
# =============================================================================

if $DRY_RUN; then
  info "[dry-run] Would install ${PACKAGE}"
  if $HAS_OPENCLAW; then
    info "[dry-run] Would configure OpenClaw plugin in ${OPENCLAW_JSON}"
  else
    info "[dry-run] Would write env config to ~/.config/lotl/.env"
  fi
  info "[dry-run] Done (no changes made)"
  exit 0
fi

if ! $HAS_QMD; then
  info "Installing ${PACKAGE}..."
  if $HAS_OPENCLAW; then
    openclaw plugins install "$PACKAGE" || {
      warn "openclaw plugins install failed, falling back to npm"
      npm install -g "$PACKAGE"
    }
  else
    npm install -g "$PACKAGE"
  fi
  ok "QMD installed ✓"
fi

# =============================================================================
# Provider selection
# =============================================================================

if $LOCAL_ONLY; then
  PROVIDER="local"
fi

if [[ -z "$PROVIDER" ]]; then
  echo ""
  info "Select a provider plan:"
  echo ""
  echo "  A) SiliconFlow    — Free tier, embed + rerank + expansion"
  echo "  B) Nebius + ZE    — Best quality (Nebius embed, ZeroEntropy rerank)"
  echo "  C) OpenAI         — Simplest setup, one API key"
  echo "  D) Local embed    — LOTL_EMBED_BACKEND=transformers (opt-in ONNX)"
  echo ""
  read -rp "Choose [A/B/C/D]: " choice
  case "${choice^^}" in
    A) PROVIDER="siliconflow" ;;
    B) PROVIDER="nebius" ;;
    C) PROVIDER="openai" ;;
    D) PROVIDER="local" ;;
    *) err "Invalid choice: $choice"; exit 1 ;;
  esac
fi

# =============================================================================
# Collect API keys
# =============================================================================

declare -A ENV_VARS=()

case "$PROVIDER" in
  siliconflow)
    echo ""
    info "SiliconFlow setup (https://cloud.siliconflow.cn — free tier available)"
    read -rp "SiliconFlow API key: " SF_KEY
    if [[ -z "$SF_KEY" ]]; then err "API key required"; exit 1; fi
    ENV_VARS=(
      [LOTL_EMBED_PROVIDER]="siliconflow"
      [LOTL_EMBED_API_KEY]="$SF_KEY"
      [LOTL_EMBED_MODEL]="Qwen/Qwen3-Embedding-8B"
      [LOTL_RERANK_PROVIDER]="siliconflow"
      [LOTL_RERANK_API_KEY]="$SF_KEY"
      [LOTL_RERANK_MODEL]="BAAI/bge-reranker-v2-m3"
      [LOTL_RERANK_MODE]="rerank"
      [LOTL_QUERY_EXPANSION_PROVIDER]="siliconflow"
      [LOTL_QUERY_EXPANSION_API_KEY]="$SF_KEY"
      [LOTL_QUERY_EXPANSION_MODEL]="zai-org/GLM-4.5-Air"
    )
    ;;
  nebius)
    echo ""
    info "Nebius + ZeroEntropy setup"
    read -rp "Nebius API key: " NEB_KEY
    read -rp "ZeroEntropy API key: " ZE_KEY
    if [[ -z "$NEB_KEY" || -z "$ZE_KEY" ]]; then err "Both keys required"; exit 1; fi
    ENV_VARS=(
      [LOTL_EMBED_PROVIDER]="api"
      [LOTL_EMBED_API_KEY]="$NEB_KEY"
      [LOTL_EMBED_URL]="https://api.studio.nebius.ai/v1"
      [LOTL_EMBED_MODEL]="Qwen3-Embedding-8B"
      [LOTL_RERANK_PROVIDER]="zeroentropy"
      [LOTL_RERANK_API_KEY]="$ZE_KEY"
      [LOTL_RERANK_MODEL]="zerank-2"
      [LOTL_QUERY_EXPANSION_PROVIDER]="api"
      [LOTL_QUERY_EXPANSION_API_KEY]="$NEB_KEY"
      [LOTL_QUERY_EXPANSION_URL]="https://api.studio.nebius.ai/v1"
      [LOTL_QUERY_EXPANSION_MODEL]="meta-llama/Meta-Llama-3.1-70B-Instruct"
    )
    ;;
  openai)
    echo ""
    info "OpenAI setup"
    read -rp "OpenAI API key: " OAI_KEY
    if [[ -z "$OAI_KEY" ]]; then err "API key required"; exit 1; fi
    ENV_VARS=(
      [LOTL_EMBED_PROVIDER]="openai"
      [LOTL_EMBED_API_KEY]="$OAI_KEY"
      [LOTL_EMBED_MODEL]="text-embedding-3-small"
      [LOTL_EMBED_DIMENSIONS]="1536"
      [LOTL_QUERY_EXPANSION_PROVIDER]="openai"
      [LOTL_QUERY_EXPANSION_API_KEY]="$OAI_KEY"
      [LOTL_QUERY_EXPANSION_MODEL]="gpt-4o-mini"
    )
    ;;
  local)
    info "Local embed mode (opt-in transformers.js ONNX backend, no API keys)"
    ENV_VARS=([LOTL_EMBED_BACKEND]="transformers")
    ;;
  *)
    err "Unknown provider: $PROVIDER"
    exit 1
    ;;
esac

# =============================================================================
# Probe endpoints
# =============================================================================

if [[ "$PROVIDER" != "local" ]]; then
  info "Probing endpoints..."
  PROBE_OK=true

  # Quick embed probe
  EMBED_URL="${ENV_VARS[LOTL_EMBED_URL]:-}"
  EMBED_PROVIDER="${ENV_VARS[LOTL_EMBED_PROVIDER]}"
  EMBED_KEY="${ENV_VARS[LOTL_EMBED_API_KEY]}"
  EMBED_MODEL="${ENV_VARS[LOTL_EMBED_MODEL]}"

  if [[ -n "$EMBED_KEY" ]]; then
    # Resolve URL for shorthand providers
    case "$EMBED_PROVIDER" in
      siliconflow) PROBE_URL="https://api.siliconflow.cn/v1/embeddings" ;;
      openai) PROBE_URL="https://api.openai.com/v1/embeddings" ;;
      *) PROBE_URL="${EMBED_URL}/embeddings" ;;
    esac

    HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
      -X POST "$PROBE_URL" \
      -H "Authorization: Bearer $EMBED_KEY" \
      -H "Content-Type: application/json" \
      -d "{\"model\":\"$EMBED_MODEL\",\"input\":\"test\"}" \
      --connect-timeout 10 2>/dev/null || echo "000")

    if [[ "$HTTP_CODE" == "200" ]]; then
      ok "Embed endpoint: OK (${HTTP_CODE})"
    else
      warn "Embed endpoint: HTTP ${HTTP_CODE} (may need to verify API key/model)"
      PROBE_OK=false
    fi
  fi

  if ! $PROBE_OK; then
    read -rp "Continue anyway? [y/N]: " cont
    if [[ "${cont^^}" != "Y" ]]; then
      err "Aborted. Fix your API keys and try again."
      exit 1
    fi
  fi
fi

# =============================================================================
# Write config
# =============================================================================

if $HAS_OPENCLAW; then
  info "Configuring OpenClaw plugin..."

  # Build plugin config JSON safely using jq (avoids injection from API keys)
  build_plugin_config() {
    if ! command -v jq &>/dev/null; then
      # Fallback: manual JSON with escaped values
      # This is safe because we control all the provider/model strings
      # and API keys don't contain control characters in practice
      local cfg='{"autoRecall":true,"autoCapture":true}'
      echo "$cfg"
      return
    fi

    local cfg
    cfg=$(jq -n '{autoRecall: true, autoCapture: true}')

    if [[ "$PROVIDER" == "local" ]]; then
      cfg=$(echo "$cfg" | jq '.local = true')
    else
      # Embed
      if [[ -n "${ENV_VARS[LOTL_EMBED_PROVIDER]:-}" ]]; then
        cfg=$(echo "$cfg" | jq \
          --arg provider "${ENV_VARS[LOTL_EMBED_PROVIDER]}" \
          --arg apiKey "${ENV_VARS[LOTL_EMBED_API_KEY]:-}" \
          --arg url "${ENV_VARS[LOTL_EMBED_URL]:-}" \
          --arg model "${ENV_VARS[LOTL_EMBED_MODEL]:-}" \
          --arg dimensions "${ENV_VARS[LOTL_EMBED_DIMENSIONS]:-}" \
          '.embed = {provider: $provider}
           | if $apiKey != "" then .embed.apiKey = $apiKey else . end
           | if $url != "" then .embed.url = $url else . end
           | if $model != "" then .embed.model = $model else . end
           | if $dimensions != "" then .embed.dimensions = ($dimensions | tonumber) else . end')
      fi

      # Rerank
      if [[ -n "${ENV_VARS[LOTL_RERANK_PROVIDER]:-}" ]]; then
        cfg=$(echo "$cfg" | jq \
          --arg provider "${ENV_VARS[LOTL_RERANK_PROVIDER]}" \
          --arg apiKey "${ENV_VARS[LOTL_RERANK_API_KEY]:-}" \
          --arg url "${ENV_VARS[LOTL_RERANK_URL]:-}" \
          --arg model "${ENV_VARS[LOTL_RERANK_MODEL]:-}" \
          --arg mode "${ENV_VARS[LOTL_RERANK_MODE]:-}" \
          '.rerank = {provider: $provider}
           | if $apiKey != "" then .rerank.apiKey = $apiKey else . end
           | if $url != "" then .rerank.url = $url else . end
           | if $model != "" then .rerank.model = $model else . end
           | if $mode != "" then .rerank.mode = $mode else . end')
      fi

      # Query expansion
      if [[ -n "${ENV_VARS[LOTL_QUERY_EXPANSION_PROVIDER]:-}" ]]; then
        cfg=$(echo "$cfg" | jq \
          --arg provider "${ENV_VARS[LOTL_QUERY_EXPANSION_PROVIDER]}" \
          --arg apiKey "${ENV_VARS[LOTL_QUERY_EXPANSION_API_KEY]:-}" \
          --arg url "${ENV_VARS[LOTL_QUERY_EXPANSION_URL]:-}" \
          --arg model "${ENV_VARS[LOTL_QUERY_EXPANSION_MODEL]:-}" \
          '.queryExpansion = {provider: $provider}
           | if $apiKey != "" then .queryExpansion.apiKey = $apiKey else . end
           | if $url != "" then .queryExpansion.url = $url else . end
           | if $model != "" then .queryExpansion.model = $model else . end')
      fi
    fi

    echo "$cfg"
  }

  PLUGIN_CONFIG=$(build_plugin_config)

  if command -v jq &>/dev/null && [[ -f "$OPENCLAW_JSON" ]]; then
    # Backup
    cp "$OPENCLAW_JSON" "${OPENCLAW_JSON}.bak"
    info "Backed up ${OPENCLAW_JSON} → ${OPENCLAW_JSON}.bak"

    # Merge with jq (--argjson safely passes the config object)
    if jq --arg pluginId "$PLUGIN_ID" --argjson config "$PLUGIN_CONFIG" '
      .plugins.allow = ((.plugins.allow // []) + [$pluginId] | unique) |
      .plugins.entries[$pluginId] = {
        "enabled": true,
        "config": $config
      }
    ' "$OPENCLAW_JSON" > "${OPENCLAW_JSON}.tmp"; then
      mv "${OPENCLAW_JSON}.tmp" "$OPENCLAW_JSON"
      ok "Updated ${OPENCLAW_JSON}"
    else
      rm -f "${OPENCLAW_JSON}.tmp"
      err "Failed to merge config into ${OPENCLAW_JSON}"
      warn "Restore backup: cp ${OPENCLAW_JSON}.bak ${OPENCLAW_JSON}"
      exit 1
    fi
  else
    echo ""
    warn "jq not found or no openclaw.json. Add this to your openclaw.json manually:"
    echo ""
    echo '  "plugins": {'
    echo "    \"allow\": [\"$PLUGIN_ID\"],"
    echo '    "entries": {'
    echo "      \"$PLUGIN_ID\": {"
    echo '        "enabled": true,'
    echo "        \"config\": $(echo "$PLUGIN_CONFIG" | jq -c . 2>/dev/null || echo "$PLUGIN_CONFIG")"
    echo '      }'
    echo '    }'
    echo '  }'
    echo ""
  fi
else
  # Write .env file for standalone CLI/MCP
  LOTL_CONFIG_DIR="${LOTL_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/lotl}"
  mkdir -p "$LOTL_CONFIG_DIR"
  ENV_FILE="$LOTL_CONFIG_DIR/.env"

  if [[ -f "$ENV_FILE" ]]; then
    cp "$ENV_FILE" "${ENV_FILE}.bak"
    info "Backed up ${ENV_FILE} → ${ENV_FILE}.bak"
  fi

  {
    echo "# QMD configuration — generated by setup-lotl.sh v${VERSION}"
    echo "# $(date -Iseconds)"
    echo ""
    for key in "${!ENV_VARS[@]}"; do
      echo "${key}=${ENV_VARS[$key]}"
    done
  } > "$ENV_FILE"

  ok "Wrote config to ${ENV_FILE}"
fi

# =============================================================================
# Verify
# =============================================================================

echo ""
if command -v lotl &>/dev/null; then
  info "Verifying installation..."
  lotl status 2>/dev/null && ok "QMD is ready ✓" || warn "lotl status returned non-zero (may need collections)"
fi

# =============================================================================
# Next steps
# =============================================================================

echo ""
ok "Setup complete!"
echo ""
info "Next steps:"
echo "  1. Add content:  lotl collection add ~/path/to/markdown --name myknowledge"
echo "  2. Embed:        lotl embed"
echo "  3. Search:       lotl query 'your question here'"
if $HAS_OPENCLAW; then
  echo "  4. Restart:      openclaw gateway restart"
  echo "  5. Verify:       openclaw plugins doctor"
fi
echo ""
