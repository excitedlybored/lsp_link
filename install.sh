#!/usr/bin/env bash
set -e

echo "=================================================="
echo "LSP-Link Install"
echo "=================================================="

# 1. The complete npm dependency closure is committed as tarballs in
#    vendor/npm. --offline prevents fallback to a configured registry such as a
#    company Artifactory if a tarball or lockfile entry is missing.
echo "[1/3] Installing Node.js packages from vendor/npm (strictly offline)..."
npm ci --offline

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

# 3. Python virtual environment for analyzer tooling. vendor/python seeds the
#    install, but uv may use its configured Python index for missing wheels.
echo "[3/3] Initializing Python .venv..."
if command -v uv >/dev/null 2>&1; then
  if [ ! -d ".venv" ]; then
    uv venv --python 3.12 .venv
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
