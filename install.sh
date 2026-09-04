#!/usr/bin/env bash
set -e

echo "=================================================="
echo "LSP-Link Install"
echo "=================================================="

# 1. The complete npm dependency closure is committed as tarballs in
#    vendor/npm. --offline prevents fallback to a configured registry such as a
#    company Artifactory if a tarball or lockfile entry is missing.
echo "[1/7] Installing Node.js packages from vendor/npm (strictly offline)..."
npm ci --offline

# Verify JavaScript packages and the LadybugDB native addon. On macOS the
# helper repairs only a confirmed custom-prefix OpenSSL loader failure.
echo "[2/7] Verifying vendored Node packages installed correctly..."
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
node scripts/prepare-ladybug-native.mjs

# 3. Verify the bundled JVM language-server distributions. Both runtimes are
#    clone-local and require no editor extension, PATH entry, or network
#    download.
echo "[3/7] Verifying bundled Eclipse JDT.LS runtime..."
jdtls_launcher=$(find vendor/jdtls/1.57.0/plugins -maxdepth 1 -name 'org.eclipse.equinox.launcher_*.jar' -print -quit)
if [ -z "$jdtls_launcher" ]; then
  echo "  Bundled Eclipse JDT.LS launcher is missing from vendor/jdtls/1.57.0." >&2
  exit 1
fi
echo "  Eclipse JDT.LS 1.57.0 OK"

echo "[4/7] Verifying bundled JetBrains Kotlin LSP runtime..."
kotlin_lsp_version_expected="262.9593.0"
kotlin_lsp_archive_dir="vendor/kotlin-lsp/archive"
kotlin_lsp_install_root=".gitnexus/tools/kotlin-lsp"
kotlin_lsp_runtime="${kotlin_lsp_install_root}/${kotlin_lsp_version_expected}"
kotlin_lsp_launcher="${kotlin_lsp_runtime}/bin/intellij-server"
kotlin_lsp_platform_marker="${kotlin_lsp_runtime}/.gitnexus-platform"
kotlin_lsp_host="$(uname -s)-$(uname -m)"
case "$kotlin_lsp_host" in
  Linux-x86_64)
    kotlin_lsp_platform="linux-x64"
    kotlin_lsp_archive_prefix="kotlin-lsp-${kotlin_lsp_version_expected}-linux-x64.tar.zst.part-"
    kotlin_lsp_archive_format="tar-zstd"
    kotlin_lsp_staged_name="$kotlin_lsp_version_expected"
    ;;
  Darwin-arm64)
    kotlin_lsp_platform="macos-arm64"
    kotlin_lsp_archive_prefix="kotlin-lsp-${kotlin_lsp_version_expected}-macos-arm64.sit.part-"
    kotlin_lsp_archive_format="zip"
    kotlin_lsp_staged_name="kotlin-server-${kotlin_lsp_version_expected}"
    kotlin_lsp_archive_sha256="6ba6021a706b21e64cef33f7e2b79f187c0910320722bb2d3ed05ad1115ec43f"
    ;;
  *)
    kotlin_lsp_platform=""
    echo "  No bundled Kotlin LSP for $kotlin_lsp_host; use GITNEXUS_KOTLIN_LSP_BIN on this host."
    ;;
esac

if [ -n "$kotlin_lsp_platform" ]; then
  kotlin_lsp_installed_platform=""
  if [ -f "$kotlin_lsp_platform_marker" ]; then
    kotlin_lsp_installed_platform=$(tr -d '[:space:]' < "$kotlin_lsp_platform_marker")
  fi
  if [ ! -x "$kotlin_lsp_launcher" ] || [ "$kotlin_lsp_installed_platform" != "$kotlin_lsp_platform" ]; then
    if ! command -v zstd >/dev/null 2>&1; then
      if [ "$kotlin_lsp_archive_format" = "tar-zstd" ]; then
        echo "  'zstd' is required to unpack the bundled Kotlin LSP runtime." >&2
        exit 1
      fi
    fi
    if command -v sha256sum >/dev/null 2>&1; then
      kotlin_lsp_checksum_command="sha256sum"
    elif command -v shasum >/dev/null 2>&1; then
      kotlin_lsp_checksum_command="shasum -a 256"
    else
      echo "  'sha256sum' or 'shasum' is required to verify the bundled Kotlin LSP runtime." >&2
      exit 1
    fi
    echo "  Verifying Kotlin LSP archive chunks..."
    (
      cd "$kotlin_lsp_archive_dir"
      if [ "$kotlin_lsp_checksum_command" = "sha256sum" ]; then
        sha256sum -c SHA256SUMS
      else
        shasum -a 256 -c SHA256SUMS
      fi
    )
    mkdir -p "$kotlin_lsp_install_root"
    kotlin_lsp_staging=$(mktemp -d "${kotlin_lsp_install_root}/.extract-${kotlin_lsp_version_expected}.XXXXXX")
    kotlin_lsp_parts=("${kotlin_lsp_archive_dir}/${kotlin_lsp_archive_prefix}"*)
    if [ ! -e "${kotlin_lsp_parts[0]}" ]; then
      echo "  Bundled Kotlin LSP archive chunks are missing." >&2
      find "$kotlin_lsp_staging" -depth -delete
      exit 1
    fi
    if [ "$kotlin_lsp_archive_format" = "tar-zstd" ]; then
      if ! (set -o pipefail; cat "${kotlin_lsp_parts[@]}" | zstd -d --no-progress | tar --same-permissions -xf - -C "$kotlin_lsp_staging"); then
        echo "  Failed to extract the bundled Kotlin LSP runtime." >&2
        find "$kotlin_lsp_staging" -depth -delete
        exit 1
      fi
    else
      if ! command -v ditto >/dev/null 2>&1; then
        echo "  macOS 'ditto' is required to unpack the bundled Kotlin LSP runtime." >&2
        find "$kotlin_lsp_staging" -depth -delete
        exit 1
      fi
      kotlin_lsp_archive=$(mktemp "${kotlin_lsp_install_root}/.archive-${kotlin_lsp_version_expected}.XXXXXX.sit")
      cat "${kotlin_lsp_parts[@]}" > "$kotlin_lsp_archive"
      kotlin_lsp_actual_sha256=$(shasum -a 256 "$kotlin_lsp_archive" | awk '{print $1}')
      if [ "$kotlin_lsp_actual_sha256" != "$kotlin_lsp_archive_sha256" ]; then
        rm -f "$kotlin_lsp_archive"
        find "$kotlin_lsp_staging" -depth -delete
        echo "  Bundled Kotlin LSP macOS archive checksum mismatch." >&2
        exit 1
      fi
      if ! ditto -x -k "$kotlin_lsp_archive" "$kotlin_lsp_staging"; then
        rm -f "$kotlin_lsp_archive"
        find "$kotlin_lsp_staging" -depth -delete
        echo "  Failed to extract the bundled Kotlin LSP macOS runtime." >&2
        exit 1
      fi
      rm -f "$kotlin_lsp_archive"
    fi
    kotlin_lsp_staged_runtime="${kotlin_lsp_staging}/${kotlin_lsp_staged_name}"
    chmod +x "${kotlin_lsp_staged_runtime}/bin/intellij-server" 2>/dev/null || true
    if [ ! -x "${kotlin_lsp_staged_runtime}/bin/intellij-server" ]; then
      echo "  Extracted Kotlin LSP launcher is missing." >&2
      find "$kotlin_lsp_staging" -depth -delete
      exit 1
    fi
    printf '%s\n' "$kotlin_lsp_platform" > "${kotlin_lsp_staged_runtime}/.gitnexus-platform"
    if [ -e "$kotlin_lsp_runtime" ]; then
      kotlin_lsp_previous="${kotlin_lsp_runtime}.previous.$$"
      mv "$kotlin_lsp_runtime" "$kotlin_lsp_previous"
    else
      kotlin_lsp_previous=""
    fi
    if mv "$kotlin_lsp_staged_runtime" "$kotlin_lsp_runtime"; then
      find "$kotlin_lsp_staging" -depth -delete
      if [ -n "$kotlin_lsp_previous" ]; then find "$kotlin_lsp_previous" -depth -delete; fi
    else
      if [ -n "$kotlin_lsp_previous" ]; then mv "$kotlin_lsp_previous" "$kotlin_lsp_runtime"; fi
      find "$kotlin_lsp_staging" -depth -delete
      echo "  Failed to publish the extracted Kotlin LSP runtime." >&2
      exit 1
    fi
  fi
  if [ ! -x "$kotlin_lsp_launcher" ]; then
    echo "  Bundled Kotlin LSP launcher is missing from $kotlin_lsp_runtime." >&2
    exit 1
  fi
  kotlin_lsp_version=$($kotlin_lsp_launcher --version)
  if [ "$kotlin_lsp_version" != "LS-${kotlin_lsp_version_expected}" ]; then
    echo "  Bundled Kotlin LSP version mismatch: expected LS-${kotlin_lsp_version_expected}, got $kotlin_lsp_version." >&2
    exit 1
  fi
  echo "  JetBrains Kotlin LSP $kotlin_lsp_version OK"
fi

# 5. Install the platform-independent Spring Tools VS Code extension from the
#    committed VSIX. The runtime locator uses this clone-local copy before
#    falling back to editor installations or the user cache.
echo "[5/7] Verifying bundled Spring Tools runtime..."
spring_tools_version="5.3.0.RELEASE"
spring_tools_archive="vendor/spring-tools/vscode-spring-boot-${spring_tools_version}.vsix"
spring_tools_sha256="8e555da123e5b4edb7449d3ef1f922a922503e64a86cd66cbe713638f94a9e50"
spring_tools_install_root=".gitnexus/tools/spring-tools"
spring_tools_runtime="${spring_tools_install_root}/${spring_tools_version}"
spring_tools_extension="${spring_tools_runtime}/extension"
spring_tools_server=$(find "$spring_tools_extension/language-server" -maxdepth 1 -name '*spring-boot-language-server*.jar' -print -quit 2>/dev/null || true)
if [ -z "$spring_tools_server" ]; then
  if [ ! -f "$spring_tools_archive" ]; then
    echo "  Bundled Spring Tools archive is missing: $spring_tools_archive" >&2
    exit 1
  fi
  if command -v sha256sum >/dev/null 2>&1; then
    spring_tools_actual_sha256=$(sha256sum "$spring_tools_archive" | awk '{print $1}')
  elif command -v shasum >/dev/null 2>&1; then
    spring_tools_actual_sha256=$(shasum -a 256 "$spring_tools_archive" | awk '{print $1}')
  else
    echo "  'sha256sum' or 'shasum' is required to verify Spring Tools." >&2
    exit 1
  fi
  if [ "$spring_tools_actual_sha256" != "$spring_tools_sha256" ]; then
    echo "  Bundled Spring Tools archive checksum mismatch." >&2
    exit 1
  fi
  if ! command -v unzip >/dev/null 2>&1; then
    echo "  'unzip' is required to install the bundled Spring Tools runtime." >&2
    exit 1
  fi
  mkdir -p "$spring_tools_install_root"
  spring_tools_staging=$(mktemp -d "${spring_tools_install_root}/.extract-${spring_tools_version}.XXXXXX")
  if ! unzip -q "$spring_tools_archive" -d "$spring_tools_staging"; then
    find "$spring_tools_staging" -depth -delete
    echo "  Failed to extract the bundled Spring Tools runtime." >&2
    exit 1
  fi
  if [ ! -d "$spring_tools_staging/extension/language-server" ]; then
    find "$spring_tools_staging" -depth -delete
    echo "  Extracted Spring Tools language server is missing." >&2
    exit 1
  fi
  spring_tools_previous=""
  if [ -e "$spring_tools_runtime" ]; then
    spring_tools_previous="${spring_tools_runtime}.previous.$$"
    mv "$spring_tools_runtime" "$spring_tools_previous"
  fi
  if mv "$spring_tools_staging" "$spring_tools_runtime"; then
    if [ -n "$spring_tools_previous" ]; then find "$spring_tools_previous" -depth -delete; fi
  else
    if [ -n "$spring_tools_previous" ]; then mv "$spring_tools_previous" "$spring_tools_runtime"; fi
    find "$spring_tools_staging" -depth -delete
    echo "  Failed to publish the extracted Spring Tools runtime." >&2
    exit 1
  fi
fi
spring_tools_server=$(find "$spring_tools_extension/language-server" -maxdepth 1 -name '*spring-boot-language-server*.jar' -print -quit 2>/dev/null || true)
if [ -z "$spring_tools_server" ]; then
  echo "  Bundled Spring Tools language server is missing from $spring_tools_extension." >&2
  exit 1
fi
echo "  Spring Tools $spring_tools_version OK"

# 6. Compile JVM workers from checksum-verified vendored dependencies. No
#    network access is used.
echo "[6/7] Building the ASM, SootUp, and JDT batch workers..."
npm run artifact-worker:build
npm run sootup-worker:build
npm run jdt-batch-extension:build

echo "[7/7] Initializing Python .venv..."
# Use python3.12 explicitly; do not let uv select or download another Python.
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
echo "Index a repository with:  ./lsp-link index /absolute/path/to/repository"
echo "Use './lsp-link crawl ...' only for semantic performance diagnostics."
echo "=================================================="
