#!/usr/bin/env bash
# v0.0.0.3: Chromium is now bundled in the zip under chromium/ directory.
# No separate installation needed - just extract and run.
#
# We set PLAYWRIGHT_BROWSERS_PATH to point at the bundled chromium/
# directory so Playwright finds chrome (or chrome.exe on Windows via
# WSL) without needing a system install. The captcha-playwright.ts
# module also auto-detects ./chromium if this env var is missing, but
# setting it explicitly works even if the user runs from another CWD.

# Resolve the script's own directory (zip extraction folder).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export PLAYWRIGHT_BROWSERS_PATH="${SCRIPT_DIR}/chromium"

echo ""
echo "============================================"
echo "         zcode-proxy Manager"
echo "============================================"
echo ""
echo "  1. Start proxy server"
echo "  2. OAuth login (Bigmodel) - Coding Plan"
echo "  3. OAuth login (Z.AI) - Coding Plan"
echo "  4. OAuth login (Bigmodel) - Start Plan"
echo "  5. OAuth login (Z.AI) - Start Plan"
echo "  6. Import key from ZCode (Bigmodel) - Coding Plan"
echo "  7. Import key from ZCode (Z.AI) - Coding Plan"
echo "  8. Import key from ZCode (Bigmodel) - Start Plan"
echo "  9. Import key from ZCode (Z.AI) - Start Plan"
echo "  a. Check login status"
echo "  b. Logout"
echo "  c. Export credential for Render/cloud deploy"
echo "  0. Exit"
echo ""
read -p "Select: " choice

case $choice in
  1)
    echo ""
    echo "Starting proxy server..."
    echo ""
    echo "(Chromium bundled at: $PLAYWRIGHT_BROWSERS_PATH)"
    echo ""
    chmod +x zcode-proxy.exe
    ./zcode-proxy.exe serve config.yaml
    ;;
  2)
    echo ""
    echo "Starting Bigmodel OAuth login (Coding Plan)..."
    echo "Browser will open automatically for authorization..."
    echo ""
    ./zcode-proxy.exe auth login bigmodel --plan=coding-plan
    ;;
  3)
    echo ""
    echo "Starting Z.AI OAuth login (Coding Plan)..."
    echo "Browser will open automatically for authorization..."
    echo ""
    ./zcode-proxy.exe auth login zai --plan=coding-plan
    ;;
  4)
    echo ""
    echo "Starting Bigmodel OAuth login (Start Plan)..."
    echo "Browser will open automatically for authorization..."
    echo ""
    ./zcode-proxy.exe auth login bigmodel --plan=start-plan
    ;;
  5)
    echo ""
    echo "Starting Z.AI OAuth login (Start Plan)..."
    echo "Browser will open automatically for authorization..."
    echo ""
    ./zcode-proxy.exe auth login zai --plan=start-plan
    ;;
  6)
    echo ""
    echo "Importing key from ZCode (Bigmodel, Coding Plan)..."
    echo ""
    ./zcode-proxy.exe auth login bigmodel --import --plan=coding-plan
    ;;
  7)
    echo ""
    echo "Importing key from ZCode (Z.AI, Coding Plan)..."
    echo ""
    ./zcode-proxy.exe auth login zai --import --plan=coding-plan
    ;;
  8)
    echo ""
    echo "Importing key from ZCode (Bigmodel, Start Plan)..."
    echo ""
    ./zcode-proxy.exe auth login bigmodel --import --plan=start-plan
    ;;
  9)
    echo ""
    echo "Importing key from ZCode (Z.AI, Start Plan)..."
    echo ""
    ./zcode-proxy.exe auth login zai --import --plan=start-plan
    ;;
  a)
    echo ""
    ./zcode-proxy.exe auth status
    ;;
  b)
    echo ""
    ./zcode-proxy.exe auth logout
    ;;
  c)
    echo ""
    echo "Exporting credential as base64 for ZCODE_OAUTH_CREDENTIAL env var..."
    echo "(Used for Render / Fly.io / K8s deployment in oauth mode)"
    echo ""
    ./zcode-proxy.exe auth export
    ;;
  0)
    exit 0
    ;;
  *)
    echo "Invalid option"
    ;;
esac
