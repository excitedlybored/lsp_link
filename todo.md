# TODO

## Improve indexing performance

### 1. Shard multiple build roots across persistent JDT LS processes — completed

- [x] Replace one JDT LS process per build root with a bounded pool of persistent
  multi-project JDT LS processes.
- [x] Start with four shards and distribute the 40 Bazel roots between them.
- [x] Generate an Eclipse/JDT project model for every Bazel root from `JavaInfo`.
- [x] Preserve each root's source paths, generated sources, compile classpath, Java
  version, and `buildRootId` inside a shared JDT workspace.
- [x] Apply the same architecture to independent Maven, Gradle, and mixed-build
  roots where native multi-module import is unavailable.
- [x] Verify that project isolation, symbol resolution, and graph provenance remain
  correct when several projects share one language-server process.

### 2. Add incremental indexing

- Persist hashes for source content, classpaths, build configuration, JDT LS
  configuration, and dependency artifacts.
- Re-crawl only changed build roots and documents.
- Reuse unchanged LSP observations and artifact-enrichment results.
- Define invalidation rules for dependency changes, Java-version changes, and
  generated-source changes.

### 3. Parallelize requests within each language-server process

- Add bounded per-server concurrency for document symbols, hover, definition,
  implementation, type hierarchy, call hierarchy, and related requests.
- Start with a limit of four requests per JDT LS process and benchmark higher
  limits without overwhelming the server.
- Preserve deterministic output ordering and complete capability coverage.

### 4. Reuse imported JDT LS workspaces

- Retain JDT LS data directories using a build-root or shard configuration
  hash.
- Reopen a compatible imported workspace instead of importing its build model
  again.
- Invalidate cached workspaces when the classpath, Java version, project model,
  or JDT LS version changes.

### 5. Separate inventory from the deep crawl

- Inventory every document and symbol first.
- Schedule expensive per-symbol capabilities as bounded concurrent phases:
  definitions and type hierarchy, call hierarchy, then hover and signatures.
- Keep the crawl complete; change scheduling only, without dropping LSP
  capabilities or documents.

### 6. Cache dependency artifact enrichment

- Cache bytecode extraction by artifact checksum and bytecode version.
- Crawl each unique dependency artifact once, even when many build roots use
  it.
- Reuse `JvmClass`, `JvmMethod`, annotation, field, and bytecode-call evidence
  while retaining per-build-root artifact ownership.

### 7. Stream and checkpoint persistence

- Persist completed roots into staging tables immediately instead of retaining
  the entire monorepo crawl in memory.
- [x] Record atomic resumable checkpoints for every completed build root and
  for the merged LSP, call-normalization, and artifact-enrichment stages.
- [x] Validate checkpoint compatibility against source/build inputs and
  stage-affecting configuration.
- Finalize and deduplicate the canonical LadybugDB graph after all roots finish.

### 8. Benchmark before raising process concurrency

- Compare four multi-project shards with four and eight independent JDT LS
  processes.
- Measure wall time, CPU, peak memory, disk growth, import time, request latency,
  and graph coverage.
- Prefer additional processes only when resource measurements show a reliable
  improvement.

### 9. Replace `javap` text parsing with ASM-based bytecode extraction

- Keep JDT/LSP as the primary representation for repository source code.
- Replace only the `javap` output parser with structured ASM class-file parsing
  for dependency and main-build JARs.
- Preserve the existing `JvmClass`, `JvmMethod`, `JvmField`, `JvmCallSite`, and
  provenance model while adding reliable source-file, method-descriptor,
  line-number, annotation, and bytecode-offset evidence.
- Use ASM as the primary representation only when source code is unavailable,
  such as for a prebuilt internal JAR.
