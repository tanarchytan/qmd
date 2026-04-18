# Lotl Setup

One-click installer and diagnostic tools for Lotl.

## Quick Install

```bash
curl -fsSL https://raw.githubusercontent.com/tanarchytan/lotl/dev/setup/setup-lotl.sh | bash
```

Or clone and run locally:

```bash
git clone https://github.com/tanarchytan/lotl.git
bash lotl/setup/setup-lotl.sh
```

## What the Script Does

1. Checks Node.js >= 22
2. Detects OpenClaw (optional)
3. Installs `@tanarchy/lotl` via `openclaw plugins install` or `npm install -g`
4. Prompts for provider selection (SiliconFlow, Nebius+ZE, OpenAI, or local)
5. Probes endpoints to verify API keys work
6. Writes config:
   - OpenClaw: merges into `~/.openclaw/openclaw.json`
   - Standalone: writes `~/.config/lotl/.env`

## Options

```
bash setup-lotl.sh                    # Interactive setup
bash setup-lotl.sh --dry-run          # Preview without changes
bash setup-lotl.sh --provider openai  # Skip provider selection
bash setup-lotl.sh --local            # Local-only (no API keys)
bash setup-lotl.sh --uninstall        # Remove Lotl
```

## Diagnostic Scripts

### Self-Check (endpoint probe)

```bash
node setup/scripts/selfcheck.mjs                        # Read ~/.config/lotl/.env
node setup/scripts/selfcheck.mjs --config config.json   # Custom config
node setup/scripts/selfcheck.mjs --json                 # JSON output
```

Probes embed, rerank, and expansion endpoints. Reports pass/warn/fail with latency.

### Config Validation

```bash
node setup/scripts/config-validate.mjs        # Check .env + openclaw.json
node setup/scripts/config-validate.mjs --json  # JSON output
```

Checks for: placeholder API keys, missing required vars, invalid dimensions, openclaw.json plugin entry issues.

## Provider Plans

| Plan | Embed | Rerank | Expansion | Cost |
|------|-------|--------|-----------|------|
| **A: SiliconFlow** | Qwen3-Embedding-8B | bge-reranker-v2-m3 | GLM-4.5-Air | Free tier |
| **B: Nebius + ZE** | Qwen3-Embedding-8B | zerank-2 | Llama-3.1-70B | $$ |
| **C: OpenAI** | text-embedding-3-small | — | gpt-4o-mini | $$ |
| **D: Local** | mxbai-xs q8 (ONNX) | qwen3-reranker q8 | Qwen3 (remote) | Free (CPU+GPU) |
