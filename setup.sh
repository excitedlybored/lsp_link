#!/usr/bin/env bash
set -e

echo "=================================================="
echo "🚀 LSP-Link Automated Environment & Dependency Setup"
echo "=================================================="

# 1. Ensure binary execution permissions
echo "🔧 [1/4] Setting execution permissions..."
chmod +x node_modules/.bin/* 2>/dev/null || true
chmod +x lsp_server/node_modules/.bin/* 2>/dev/null || true
chmod +x gitnexus_ts_isolated/node_modules/.bin/* 2>/dev/null || true
chmod +x lsp_server/start_server.sh 2>/dev/null || true

# 2. Re-link workspaces and offline npm packages
echo "📦 [2/4] Initializing Node.js dependencies..."
if command -v npm >/dev/null 2>&1; then
  # Try offline install from committed .npm_cache or tarballs
  npm install --offline --prefer-offline 2>/dev/null || npm install 2>/dev/null || true
fi

# 3. Initialize Python virtual environment with uv
echo "🐍 [3/4] Initializing Python virtual environment (.venv)..."
if command -v uv >/dev/null 2>&1; then
  if [ ! -d ".venv" ]; then
    uv venv .venv
  fi
  uv pip install -r custom_tools/requirements.txt
else
  echo "⚠️ 'uv' not found. Installing uv or using python3 venv..."
  if command -v python3 >/dev/null 2>&1; then
    python3 -m venv .venv || true
    .venv/bin/python -m pip install -r custom_tools/requirements.txt || true
  fi
fi

# 4. Verify installation by running boundaries test
echo "🧪 [4/4] Verifying setup with test analysis..."
npm run test:examples

echo ""
echo "=================================================="
echo "✅ LSP-Link Setup Complete and Verified!"
echo "=================================================="
