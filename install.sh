#!/usr/bin/env bash
set -e

echo "=================================================="
echo "LSP-Link Install"
echo "=================================================="

# 1. Node.js dependencies. The LSP packages (pyright, typescript-language-server,
#    vscode-jsonrpc/languageserver-protocol/types, glob and its transitive deps)
#    are pinned to file: tarballs in lsp_server/vendor/, so this step never
#    touches any npm registry for them regardless of what registry is configured.
echo "[1/3] Installing Node.js packages (LSP deps resolve from lsp_server/vendor/, no registry needed)..."
npm install

echo "[2/3] Verifying vendored LSP packages installed correctly..."
node -e "
const fs = require('fs');
const path = require('path');
const pkgs = ['pyright', 'typescript-language-server', 'vscode-jsonrpc', 'vscode-languageserver-protocol', 'vscode-languageserver-types', 'glob'];
for (const p of pkgs) {
  const pkgJsonPath = path.join(__dirname, 'node_modules', p, 'package.json');
  const v = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8')).version;
  console.log('  ' + p + '@' + v + ' OK');
}
"

# 3. Python virtual environment for the analyzer tooling (unrelated to the LSP
#    npm dependency chain, uses the existing vendor/python offline wheel cache).
echo "[3/3] Initializing Python .venv..."
if command -v uv >/dev/null 2>&1; then
  if [ ! -d ".venv" ]; then
    uv venv .venv
  fi
  if [ -d "vendor/python" ]; then
    uv pip install --find-links vendor/python -r analyzer/requirements.lock.txt
  else
    uv pip install -r analyzer/requirements.txt
  fi
else
  echo "  'uv' not found, skipping Python setup (install uv, then re-run this script, if you need it)."
fi

echo ""
echo "=================================================="
echo "Install complete."
echo "Start the LSP server with:  npm run server"
echo "=================================================="
