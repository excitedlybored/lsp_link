# Vendored dependencies

`npm/` is the canonical, clone-local npm package source. The root
`package-lock.json` must resolve every npm package to one of these tarballs;
`.npmrc` and `install.sh` enforce offline installation so npm cannot fall back
to a configured registry or Artifactory.

After intentionally refreshing package tarballs, run:

```bash
node scripts/vendor-lock.mjs
npm ci --offline --cache "$(mktemp -d)"
```

The vendor set includes native LadybugDB packages for macOS ARM64/x64, Linux
ARM64/x64, and Windows x64, along with the esbuild platforms represented by the
lockfile. Do not commit extracted `node_modules` trees; tarballs are the single
npm representation in Git.

`python/` seeds the Python analyzer installation. Unlike npm installation, uv
may use its configured Python index for wheels that are not committed here.

`jdtls/` contains the extracted pinned Java language-server runtime.
`kotlin-lsp/archive/` contains the pinned Linux x64 Kotlin language server as
checksum-verified, 90,000,000-byte maximum archive chunks. `install.sh`
stream-extracts those chunks into the ignored `.gitnexus/tools/kotlin-lsp/`
cache, avoiding both network access and Git blobs at or above 100 MB. The
adapters select these clone-local runtimes, so indexing does not depend on
editor extensions or user-profile launchers.

`spring-tools/` contains the pinned, platform-independent official Spring Tools
VSIX. Its single 83,000,863-byte blob remains below Git hosting's 100 MB limit.
`install.sh` verifies its SHA-256 and atomically extracts it into the ignored
`.gitnexus/tools/spring-tools/` cache, so Spring analysis also works offline and
does not depend on a VS Code or Cursor extension.
