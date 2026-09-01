# JetBrains Kotlin LSP runtime

This directory contains the official JetBrains Kotlin Language Server
distribution used by LSP Link for Kotlin indexing. Version-pinned Linux x64
and macOS ARM64 archives are split into Git-safe chunks under `archive/`. They
include JetBrains Runtime, so a clone can perform Kotlin LSP analysis without
an editor extension, a system JDK, or a network download.

| Field | Value |
| --- | --- |
| Version | 262.9593.0 (`LS-262.9593.0`) |
| Hosts | Linux x86-64; macOS ARM64 |
| Linux source | `https://download.jetbrains.com/language-server/kotlin-server/262.9593.0/kotlin-server-262.9593.0.tar.gz` (`2d99d8e198fbe4aa8f4481e37799724ce94803b4ea12a60b416040e3fcd7cc5e`) |
| macOS ARM64 source | `https://download.jetbrains.com/language-server/kotlin-server/262.9593.0/kotlin-server-262.9593.0-aarch64.sit` (`6ba6021a706b21e64cef33f7e2b79f187c0910320722bb2d3ed05ad1115ec43f`) |
| Vendored representations | `archive/kotlin-lsp-262.9593.0-linux-x64.tar.zst.part-*`; `archive/kotlin-lsp-262.9593.0-macos-arm64.sit.part-*` |
| Chunk checksums | `archive/SHA256SUMS` |
| Installed location | `.gitnexus/tools/kotlin-lsp/262.9593.0` |
| Distribution license metadata | Installed `license/` and `jbr/legal/` directories |

`install.sh` selects the matching host archive, verifies every chunk, checks
the upstream macOS archive checksum, and checks `intellij-server --version`.
Preserve the embedded license and legal directories when updating the runtime.
Download a replacement only from JetBrains, verify its SHA-256, create chunks
smaller than 100,000,000 bytes, and update the adapter locator, installer check,
checksums, and this manifest together.
