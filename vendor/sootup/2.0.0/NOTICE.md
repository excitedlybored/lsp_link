# SootUp runtime closure

This directory contains the checksum-locked runtime dependency closure for
`org.soot-oss:sootup.java.bytecode.frontend:2.0.0`.

SootUp is distributed under LGPL-2.1. The worker links to the unmodified JARs
at runtime; the dependencies are not merged into the GitNexus worker JAR.
Upstream source and license text are available at:

- https://github.com/soot-oss/SootUp/tree/v2.0.0
- https://github.com/soot-oss/SootUp/blob/v2.0.0/LICENSE

The remaining transitive artifacts retain their upstream licenses. Exact file
names and SHA-256 hashes are recorded in `dependencies.lock.json`.
