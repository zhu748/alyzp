#!/usr/bin/env bash
# Render container entrypoint for zcode-proxy.
#
# Responsibilities:
#   1. Map Render's $PORT -> $ZCODE_PROXY_PORT (the env var the proxy reads).
#   2. Pick a writable data dir: /data if a persistent disk is mounted (paid
#      Render), else /tmp/zcode-proxy (free tier, ephemeral).
#   3. Seed config.yaml on first run from the bundled template so the proxy
#      has something to load. Sensitive fields (apiKey, proxyApiKey) come
#      from env vars at runtime, NOT from this file — env vars override
#      YAML per src/config/loader.ts.
#   4. exec bun run src/index.ts so signals (SIGTERM) reach the proxy
#      directly for graceful shutdown.
set -euo pipefail

# Resolve the app directory: where this script lives. In the Docker image
# this is /app; for local `bash render-start.sh` it's the repo root.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="${APP_DIR:-$SCRIPT_DIR}"
cd "$APP_DIR"

# --- 1. PORT mapping ---------------------------------------------------------
# Render sets PORT. If unset (local `docker run`), default to 8080.
if [ -n "${PORT:-}" ]; then
  export ZCODE_PROXY_PORT="$PORT"
fi
: "${ZCODE_PROXY_PORT:=8080}"
echo "[render-start] ZCODE_PROXY_PORT=${ZCODE_PROXY_PORT}"

# --- 2. Writable data dir ----------------------------------------------------
# /data exists in the Dockerfile, but may not be writable on Render free tier
# (no persistent disk attached). Fall back to /tmp/zcode-proxy in that case.
DATA_DIR="/data"
if [ ! -w "/data" ]; then
  DATA_DIR="/tmp/zcode-proxy"
  mkdir -p "$DATA_DIR"
  echo "[render-start] /data not writable — using ephemeral $DATA_DIR instead."
  echo "[render-start] (On Render free tier, OAuth credentials will NOT persist across restarts. Use auth.mode=apikey instead.)"
fi

# Config file path: explicit env wins, else $DATA_DIR/config.yaml
if [ -z "${ZCODE_PROXY_CONFIG:-}" ] || [ ! -d "$(dirname "$ZCODE_PROXY_CONFIG")" ]; then
  export ZCODE_PROXY_CONFIG="$DATA_DIR/config.yaml"
fi
echo "[render-start] ZCODE_PROXY_CONFIG=${ZCODE_PROXY_CONFIG}"

# Credential store dir: explicit env wins, else $DATA_DIR/.zcode-proxy
if [ -z "${ZCODE_PROXY_STORE_DIR:-}" ] || [ ! -d "$ZCODE_PROXY_STORE_DIR" ]; then
  export ZCODE_PROXY_STORE_DIR="$DATA_DIR/.zcode-proxy"
fi
mkdir -p "$ZCODE_PROXY_STORE_DIR"
echo "[render-start] ZCODE_PROXY_STORE_DIR=${ZCODE_PROXY_STORE_DIR}"

# --- 3. Seed config.yaml from template on first run --------------------------
# The proxy's index.ts already auto-creates config.yaml from config.example.yaml
# if missing — but only if the parent dir is writable. We pre-create it here
# so the failure mode is visible at startup, not buried in a request handler.
if [ ! -f "$ZCODE_PROXY_CONFIG" ]; then
  echo "[render-start] Seeding $ZCODE_PROXY_CONFIG from config.example.yaml"
  # Strip the placeholder API key — we want env vars (ZCODE_API_KEY /
  # ZCODE_PROXY_API_KEY) to be the single source of truth on Render.
  # Keeping an empty apiKey in YAML forces env-var resolution.
  sed 's|apiKey: "YOUR_API_KEY_HERE"|apiKey: ""|' \
      "$APP_DIR/config.example.yaml" > "$ZCODE_PROXY_CONFIG"
fi

# --- 4. Sanity checks --------------------------------------------------------
# Two upstream auth modes are supported on Render:
#
#   Mode A (apikey — simpler):
#     Set ZCODE_API_KEY=<upstream-key>
#     (ZCODE_AUTH_MODE defaults to "apikey" — no need to set it.)
#
#   Mode B (oauth — for users who logged in via ZCode desktop or `zcode-proxy
#   auth login` locally and want to reuse that credential on Render):
#     Set ZCODE_AUTH_MODE=oauth
#     Set ZCODE_OAUTH_CREDENTIAL=<base64-encoded JSON Credential>
#     (Generate it locally with: zcode-proxy auth export)
#
# In Mode B, render-start.sh decodes the env var and writes it to
# $ZCODE_PROXY_STORE_DIR/credentials.json in plaintext form, then sets
# ZCODE_PROXY_ALLOW_PLAINTEXT_STORE=1 so the proxy loads it.
# (Plaintext is acceptable here because the only secret in the file is the
# upstream key, which is already exposed via the env var.)

if [ "${ZCODE_AUTH_MODE:-}" = "oauth" ]; then
  echo "[render-start] Auth mode: oauth"
  # If ZCODE_OAUTH_CREDENTIAL is set, decode and write it to the store.
  # If not set, check if a credentials.json already exists (e.g. user
  # imported via dashboard, or persistent disk has one) — if so, use it.
  # Only error out if BOTH are missing.
  EXISTING_CRED=""
  if [ -f "$ZCODE_PROXY_STORE_DIR/credentials.json" ]; then
    EXISTING_CRED="(existing credentials.json found)"
  fi

  if [ -z "${ZCODE_OAUTH_CREDENTIAL:-}" ]; then
    if [ -n "$EXISTING_CRED" ]; then
      echo "[render-start] ZCODE_OAUTH_CREDENTIAL not set, but $EXISTING_CRED — will use that."
      echo "[render-start] (If the existing credential is wrong, set ZCODE_OAUTH_CREDENTIAL to override on next deploy.)"
    else
      echo "[render-start] ERROR: ZCODE_AUTH_MODE=oauth but no credential available."
      echo "[render-start]   Either:"
      echo "[render-start]     - Set ZCODE_OAUTH_CREDENTIAL=<base64> (generate with: zcode-proxy auth export)"
      echo "[render-start]     - Import a credential via the dashboard at /admin"
      echo "[render-start]   The proxy will still start, but every upstream request will 401 until you do one of the above."
    fi
  else
    # Decode base64 and write to the credential store.
    #
    # Two payload formats are supported (auto-detected by inspecting the
    # decoded JSON):
    #
    #   1. Single credential (legacy): the decoded JSON is a bare Credential
    #      object (has `apiKey` + `provider` at the top level). We wrap it as
    #      a single-account v2 store on disk.
    #
    #   2. Full v2 store envelope (multi-account): the decoded JSON has
    #      `version: 2` + `accounts: [...]` at the top level. We write it
    #      verbatim — preserving all accounts and the activeId pointer — so
    #      users who stored multiple credentials locally can deploy them all
    #      to Render in one shot.
    #
    # The proxy's readStore() accepts the plaintext v2 form when
    # ZCODE_PROXY_ALLOW_PLAINTEXT_STORE=1.
    CRED_FILE="$ZCODE_PROXY_STORE_DIR/credentials.json"
    mkdir -p "$ZCODE_PROXY_STORE_DIR"
    echo "[render-start] Decoding ZCODE_OAUTH_CREDENTIAL → $CRED_FILE"
    CRED_JSON="$(echo "$ZCODE_OAUTH_CREDENTIAL" | base64 -d)"
    # Validate it's JSON
    if ! echo "$CRED_JSON" | bun -e 'const fs=require("fs");JSON.parse(fs.readFileSync(0,"utf8"))' 2>/dev/null; then
      echo "[render-start] ERROR: ZCODE_OAUTH_CREDENTIAL is not valid base64-encoded JSON."
      echo "[render-start]   Decoded preview (first 200 chars):"
      echo "$CRED_JSON" | head -c 200
      exit 1
    fi

    # Detect format: v2 store envelope vs. single credential.
    # We look for `version: 2` + `accounts: [...]` at the top level (the v2
    # store schema). Anything else is treated as a single Credential object.
    IS_STORE_ENVELOPE="$(echo "$CRED_JSON" | bun -e '
      const fs=require("fs");
      const j=JSON.parse(fs.readFileSync(0,"utf8"));
      process.stdout.write((j && j.version===2 && Array.isArray(j.accounts)) ? "1" : "0");
    ' 2>/dev/null)"

    if [ "$IS_STORE_ENVELOPE" = "1" ]; then
      # Multi-account: write the decoded store verbatim.
      echo "[render-start] Detected multi-account v2 store envelope — writing verbatim."
      echo "$CRED_JSON" > "$CRED_FILE"
    else
      # Single credential: wrap as v2 store. `provider` is read from the
      # credential itself for the label.
      # v0.2.0.8: use `command -v` to pick `shasum -a 256` on macOS (which
      # ships without `sha256sum`) and `sha256sum` on Linux. Both emit a
      # 64-hex-char digest; we take the first 16 for the account id.
      _HASH_CMD=""
      if command -v sha256sum >/dev/null 2>&1; then
        _HASH_CMD="sha256sum"
      elif command -v shasum >/dev/null 2>&1; then
        _HASH_CMD="shasum -a 256"
      fi
      if [ -n "$_HASH_CMD" ]; then
        ACCOUNT_ID="$(date +%s | $_HASH_CMD | head -c 16)"
      else
        # Fallback: bun-native random string (works everywhere bun runs).
        ACCOUNT_ID="$(bun -e 'console.log(Math.random().toString(36).slice(2,18))')"
      fi
      NOW_MS="$(date +%s%3N)"
      echo "[render-start] Detected single credential — wrapping as single-account v2 store."
      cat > "$CRED_FILE" <<EOF
{
  "version": 2,
  "activeId": "$ACCOUNT_ID",
  "accounts": [
    {
      "id": "$ACCOUNT_ID",
      "label": "oauth-import (Render)",
      "createdAt": $NOW_MS,
      "credential": $CRED_JSON
    }
  ]
}
EOF
    fi
    export ZCODE_PROXY_ALLOW_PLAINTEXT_STORE=1
    echo "[render-start] OAuth credential installed. (Plaintext store enabled for this session.)"
  fi
elif [ -n "${ZCODE_API_KEY:-}" ]; then
  echo "[render-start] Auth mode: apikey (ZCODE_API_KEY is set)"
  : "${ZCODE_AUTH_MODE:=apikey}"
  export ZCODE_AUTH_MODE
else
  echo "[render-start] WARNING: Neither ZCODE_API_KEY nor ZCODE_OAUTH_CREDENTIAL is set."
  echo "[render-start]   The proxy will start, but every upstream request will 401."
  echo "[render-start]   Pick ONE of:"
  echo "[render-start]     - Mode A (apikey): set ZCODE_API_KEY=<upstream-key>"
  echo "[render-start]     - Mode B (oauth):  set ZCODE_AUTH_MODE=oauth + ZCODE_OAUTH_CREDENTIAL=<base64>"
  echo "[render-start]     - Or import a credential via the dashboard at /admin"
fi

if [ -z "${ZCODE_PROXY_API_KEY:-}" ]; then
  echo "[render-start] WARNING: ZCODE_PROXY_API_KEY is not set."
  echo "[render-start]   Anyone who can reach your Render URL can burn your quota."
  echo "[render-start]   Set ZCODE_PROXY_API_KEY in Render's Environment tab."
fi

# --- 5. Launch ---------------------------------------------------------------
echo "[render-start] Starting zcode-proxy..."
exec bun run src/index.ts serve "$ZCODE_PROXY_CONFIG"
