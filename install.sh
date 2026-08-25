#!/usr/bin/env bash
set -e

echo "=================================================="
echo "LSP-Link Install"
echo "=================================================="

# 1. The complete npm dependency closure is committed as tarballs in
#    vendor/npm. --offline prevents fallback to a configured registry such as a
#    company Artifactory if a tarball or lockfile entry is missing.
echo "[1/4] Installing Node.js packages from vendor/npm (strictly offline)..."
npm ci --offline

echo "[2/4] Verifying vendored Node LSP packages installed correctly..."
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

# 3. Verify the bundled Java language-server distribution before Java indexing.
echo "[3/4] Verifying bundled Eclipse JDT.LS runtime..."
jdtls_launcher=$(find vendor/jdtls/1.57.0/plugins -maxdepth 1 -name 'org.eclipse.equinox.launcher_*.jar' -print -quit)
if [ -z "$jdtls_launcher" ]; then
  echo "  Bundled Eclipse JDT.LS launcher is missing from vendor/jdtls/1.57.0." >&2
  exit 1
fi
echo "  Eclipse JDT.LS 1.57.0 OK"

# 4. Python virtual environment for analyzer tooling. Use the locally installed
#    python3.12 explicitly; do not let uv select or download a different Python.
echo "[4/4] Initializing Python .venv..."
if ! command -v uv >/dev/null 2>&1; then
  echo "  'uv' is required for Python analyzer setup. Install uv, then re-run this script." >&2
  exit 1
fi
if ! command -v python3.12 >/dev/null 2>&1; then
  echo "  'python3.12' is required for Python analyzer setup. Install Python 3.12, then re-run this script." >&2
  exit 1
fi

python312_bin=$(command -v python3.12)
venv_python=".venv/bin/python"
if [ -e "$venv_python" ]; then
  venv_version=$($venv_python -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')
  if [ "$venv_version" != "3.12" ]; then
    echo "  Existing .venv uses Python $venv_version; remove .venv and re-run to create a Python 3.12 environment." >&2
    exit 1
  fi
else
  uv venv --python "$python312_bin" .venv
fi

if [ -d "vendor/python" ]; then
  uv pip install --python "$venv_python" --find-links vendor/python -r analyzer/requirements.lock.txt
else
  uv pip install --python "$venv_python" -r analyzer/requirements.lock.txt
fi

echo ""
echo "=================================================="
echo "Install complete."
echo "Start the LSP server with:  npm run server"
echo "=================================================="
