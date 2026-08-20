#!/usr/bin/env bash
set -e

echo "=================================================="
echo "🚀 LSP-Link Fast & Offline Dependency Installer"
echo "=================================================="

# 1. Initialize Node.js dependencies from vendor/npm/
echo "📦 [1/3] Installing Node.js packages from vendor/npm/..."
if [ -d "vendor/npm" ]; then
  # Seed local cache from vendor tarballs
  mkdir -p .npm_cache
  for tgz in vendor/npm/*.tgz; do
    npm cache add "$tgz" --cache=.npm_cache 2>/dev/null || true
  done
  npm install --cache=.npm_cache --prefer-offline
else
  npm install
fi

# 2. Initialize Python virtual environment (.venv) from vendor/python/
echo "🐍 [2/3] Initializing Python .venv from vendor/python/..."
if command -v uv >/dev/null 2>&1; then
  if [ ! -d ".venv" ]; then
    uv venv .venv
  fi
  if [ -d "vendor/python" ]; then
    uv pip install --find-links vendor/python -r custom_tools/requirements.lock.txt
  else
    uv pip install -r custom_tools/requirements.txt
  fi
else
  echo "⚠️ 'uv' not found. Bootstrapping with python3 venv..."
  python3 -m venv .venv
  if [ -d "vendor/python" ]; then
    .venv/bin/python -m pip install --find-links vendor/python -r custom_tools/requirements.lock.txt
  else
    .venv/bin/python -m pip install -r custom_tools/requirements.txt
  fi
fi

# 3. Verify installation with sample test
echo "🧪 [3/3] Running boundary analysis test..."
npm run test:examples

echo ""
echo "=================================================="
echo "✅ LSP-Link Ready for Immediate Use!"
echo "=================================================="
