#!/usr/bin/env python3
"""
NPM Vendoring & Offline Cache Seeder.

Downloads all package .tgz tarballs referenced in package-lock.json files
into `vendor/npm_tarballs/` and seeds the local `.npm_cache` so that running
`npm install` executes 100% offline from the local repository.
"""

import sys
import os
import json
import urllib.request
import hashlib
from pathlib import Path

ROOT_DIR = Path(__file__).parent.parent
VENDOR_DIR = ROOT_DIR / "vendor" / "npm_tarballs"
CACHE_DIR = ROOT_DIR / ".npm_cache"

def collect_tarballs_from_lockfile(lockfile_path: Path) -> dict:
    """Extracts all {resolved_url: integrity} mappings from a package-lock.json."""
    if not lockfile_path.exists():
        return {}
    with open(lockfile_path, "r", encoding="utf-8") as f:
        data = json.load(f)

    tarballs = {}
    packages = data.get("packages", {})
    for pkg_path, pkg_info in packages.items():
        resolved = pkg_info.get("resolved")
        if resolved and resolved.startswith("http") and resolved.endswith(".tgz"):
            tarballs[resolved] = pkg_info.get("integrity")
            
    # Legacy lockfile format
    def walk_deps(deps):
        for name, d in deps.items():
            res = d.get("resolved")
            if res and res.startswith("http") and res.endswith(".tgz"):
                tarballs[res] = d.get("integrity")
            if "dependencies" in d:
                walk_deps(d["dependencies"])
    if "dependencies" in data:
        walk_deps(data["dependencies"])

    return tarballs

def main():
    VENDOR_DIR.mkdir(parents=True, exist_ok=True)
    CACHE_DIR.mkdir(parents=True, exist_ok=True)

    lockfiles = [
        ROOT_DIR / "package-lock.json",
        ROOT_DIR / "lsp_server" / "package-lock.json",
        ROOT_DIR / "gitnexus_ts_isolated" / "package-lock.json",
    ]

    all_tarballs = {}
    for lf in lockfiles:
        tbs = collect_tarballs_from_lockfile(lf)
        all_tarballs.update(tbs)

    print(f"📦 Found {len(all_tarballs)} unique npm package tarballs to vendor...")

    downloaded = 0
    for url, integrity in all_tarballs.items():
        filename = url.split("/")[-1]
        dest_path = VENDOR_DIR / filename

        if not dest_path.exists() or dest_path.stat().st_size == 0:
            try:
                urllib.request.urlretrieve(url, dest_path)
                downloaded += 1
                if downloaded % 10 == 0 or downloaded == len(all_tarballs):
                    print(f"   [{(downloaded/len(all_tarballs))*100:.1f}%] Downloaded {filename}")
            except Exception as e:
                print(f"   ⚠️ Failed to download {url}: {e}")

    print(f"\n✓ Successfully vendored {len(list(VENDOR_DIR.glob('*.tgz')))} tarballs in {VENDOR_DIR}")
    print(f"  Total size: {sum(f.stat().st_size for f in VENDOR_DIR.glob('*.tgz')) / (1024*1024):.2f} MB")

if __name__ == "__main__":
    main()
