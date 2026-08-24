#!/usr/bin/env bash
set -euo pipefail

release_api="https://api.github.com/repos/spring-projects/spring-tools/releases/latest"
cache_root="${XDG_CACHE_HOME:-${HOME}/.cache}/gitnexus/spring-tools"
temp_dir="$(mktemp -d)"
trap 'rm -rf "${temp_dir}"' EXIT

release_json="${temp_dir}/release.json"
curl -fsSL "${release_api}" -o "${release_json}"
version="$(jq -r '.tag_name' "${release_json}")"
asset_url="$(jq -r '.assets[] | select(.name | startswith("vscode-spring-boot-")) | .browser_download_url' "${release_json}" | head -n 1)"
if [[ -z "${asset_url}" ]]; then
  echo "No vscode-spring-boot VSIX found in Spring Tools ${version}" >&2
  exit 1
fi

curl -fL "${asset_url}" -o "${temp_dir}/spring-tools.vsix"
unzip -q "${temp_dir}/spring-tools.vsix" -d "${temp_dir}/unpacked"
target="${cache_root}/${version}"
mkdir -p "${cache_root}"
rm -rf "${target}"
mv "${temp_dir}/unpacked" "${target}"
ln -sfn "${target}" "${cache_root}/current"
echo "Installed Spring Tools ${version} at ${target}/extension"
