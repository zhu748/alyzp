#!/usr/bin/env bash

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
echo "  i. Install/Update Chromium (for start-plan captcha)"
echo "  0. Exit"
echo ""
read -p "Select: " choice

case $choice in
  1)
    echo ""
    echo "Starting proxy server..."
    echo ""
    echo "(If start-plan captcha fails with 'Executable doesn't exist',"
    echo " run option i first to install Chromium.)"
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
  i)
    echo ""
    echo "============================================"
    echo " Installing Chromium for Playwright captcha"
    echo "============================================"
    echo ""
    echo "This downloads ~150MB Chromium binary to:"
    echo "  \$HOME/.cache/ms-playwright/  (Linux)"
    echo "  \$HOME/Library/Caches/ms-playwright/  (macOS)"
    echo ""
    echo "Required only for start-plan mode. Coding-plan users can skip."
    echo ""
    if command -v bun >/dev/null 2>&1; then
      echo "Found bun, using it to install Chromium..."
      bunx playwright install chromium
    elif command -v npx >/dev/null 2>&1; then
      echo "Found npx, using it to install Chromium..."
      npx playwright install chromium
    else
      echo "ERROR: Neither bun nor npx found in PATH."
      echo "Install Bun from https://bun.sh/ or Node.js from https://nodejs.org/"
      echo "Then re-run this option."
    fi
    echo ""
    ;;
  0)
    exit 0
    ;;
  *)
    echo "Invalid option"
    ;;
esac
