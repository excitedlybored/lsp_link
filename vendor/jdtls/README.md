# Eclipse JDT.LS runtime

This directory contains the official Eclipse JDT Language Server distribution
used by LSP Link for Java indexing. It is deliberately version-pinned so a
clone can run Java LSP analysis without an editor-specific installation or a
network download.

| Field | Value |
| --- | --- |
| Version | 1.57.0 |
| Build | 202602261110 |
| Source archive | `https://download.eclipse.org/jdtls/milestones/1.57.0/jdt-language-server-1.57.0-202602261110.tar.gz` |
| SHA-256 | `f7ffa93fe1bbbea95dac13dd97cdcd25c582d6e56db67258da0dcceb2302601e` |
| Primary project license | Eclipse Public License 2.0 — <https://www.eclipse.org/legal/epl-2.0/> |

The distribution includes Eclipse and third-party bundles. Their embedded
metadata remains in the bundled JARs; preserve it when updating this runtime.
Download a replacement only from Eclipse, verify its published SHA-256, extract
it into a new versioned directory, and update the runtime locator and this
manifest together.
