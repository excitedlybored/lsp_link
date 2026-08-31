# JetBrains Kotlin LSP runtime

This directory contains the official JetBrains Kotlin Language Server
distribution used by LSP Link for Kotlin indexing. The version-pinned Linux
x64 archive is recompressed deterministically and split into Git-safe chunks
under `archive/`. It includes JetBrains Runtime, so a clone can perform Kotlin
LSP analysis without an editor extension, a system JDK, or a network download.

| Field | Value |
| --- | --- |
| Version | 262.9593.0 (`LS-262.9593.0`) |
| Host | Linux x86-64 |
| Source archive | `https://download-cdn.jetbrains.com/language-server/kotlin-server/262.9593.0/kotlin-server-262.9593.0.tar.gz` |
| Source archive SHA-256 | `2d99d8e198fbe4aa8f4481e37799724ce94803b4ea12a60b416040e3fcd7cc5e` |
| Vendored representation | `archive/kotlin-lsp-262.9593.0-linux-x64.tar.zst.part-*` |
| Chunk checksums | `archive/SHA256SUMS` |
| Installed location | `.gitnexus/tools/kotlin-lsp/262.9593.0` |
| Distribution license metadata | Installed `license/` and `jbr/legal/` directories |

`install.sh` verifies every chunk, stream-extracts the archive without creating
an oversized intermediate file, and checks `intellij-server --version`.
Preserve the embedded license and legal directories when updating the runtime.
Download a replacement only from JetBrains, verify its SHA-256, create chunks
smaller than 100,000,000 bytes, and update the adapter locator, installer check,
checksums, and this manifest together.
