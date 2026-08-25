#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
LSP_ONLY=false

case "${1:-}" in
  "") ;;
  --lsp-only) LSP_ONLY=true ;;
  -h|--help)
    echo "Usage: ./install.sh [--lsp-only]"
    echo "  --lsp-only  Install only the fully vendored LSP workspace."
    exit 0
    ;;
  *)
    echo "Unknown option: $1" >&2
    echo "Usage: ./install.sh [--lsp-only]" >&2
    exit 2
    ;;
esac

cd "$ROOT_DIR"

if [ "$LSP_ONLY" = true ]; then
  TOTAL_STEPS=2
else
  TOTAL_STEPS=4
fi

echo "=================================================="
echo "LSP-Link Install"
echo "=================================================="

# 1. The LSP workspace is self-contained. Its .npmrc enforces offline mode and
#    package-lock.json resolves every package to lsp_server/vendor/.
echo "[1/$TOTAL_STEPS] Installing vendored LSP packages (offline; no registry needed)..."
npm --prefix "$ROOT_DIR/lsp_server" install

echo "[2/$TOTAL_STEPS] Verifying vendored LSP packages installed correctly..."
(cd "$ROOT_DIR/lsp_server" && node -e "
const fs = require('fs');
const path = require('path');
const pkgs = ['pyright', 'typescript-language-server', 'vscode-jsonrpc', 'vscode-languageserver-protocol', 'vscode-languageserver-types', 'glob'];
for (const p of pkgs) {
  const pkgJsonPath = path.join(__dirname, 'node_modules', p, 'package.json');
  const v = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8')).version;
  console.log('  ' + p + '@' + v + ' OK');
}
")

if [ "$LSP_ONLY" = true ]; then
  echo ""
  echo "LSP-only install complete."
  exit 0
fi

# The root analyzer dependencies are deliberately not vendored. They resolve
# through the user's configured enterprise Artifactory, while --workspaces=false
# keeps npm from reinstalling the already-isolated LSP workspace.
echo "[3/4] Installing root analyzer packages using the configured npm registry..."
npm install --workspaces=false

# 3. Python virtual environment for the analyzer tooling (unrelated to the LSP
#    npm dependency chain, uses the existing vendor/python offline wheel cache).
echo "[4/4] Initializing Python .venv..."
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
