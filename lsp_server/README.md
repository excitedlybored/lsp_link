# Standalone LSP Server (`lsp_server/`)

This directory contains the standalone server launcher for **Eclipse JDT Language Server (`eclipse.jdt.ls`)** and adapters for Kotlin, TypeScript, Python, C++, Rust, C#, and COBOL.

## Install after cloning

All Node-based LSP dependencies, including the `tsx`/esbuild binaries for
supported host platforms, are vendored in the repository-level `vendor/npm/`.
A fresh clone therefore installs without contacting npmjs or an enterprise
Artifactory:

```bash
./install.sh
```

The root `.npmrc` enforces offline installation and `./install.sh` runs `npm ci
--offline`. Do not commit an Artifactory URL or authentication token in this
repository. Java JDT.LS, clangd, rust-analyzer, and the other non-Node language
servers remain separately installed system/runtime prerequisites. Eclipse
JDT.LS 1.57.0 is bundled at `vendor/jdtls/1.57.0`. JetBrains Kotlin LSP
262.9593.0 is stored as checksum-pinned archive chunks under
`vendor/kotlin-lsp/archive` and extracted by `./install.sh` into the ignored
`.gitnexus/tools/kotlin-lsp/262.9593.0` tool cache. The adapters select these
clone-local runtimes before looking for system installations. Only a JDK 21+
remains necessary for Java indexing; Kotlin LSP includes its own runtime.

### Kotlin

The registry includes the official JetBrains Kotlin LSP adapter for `.kt` and
`.kts`. The checksum-pinned Linux x64 distribution and its Java runtime are
committed as four Git-safe archive chunks of at most 90,000,000 bytes.
`./install.sh` verifies every chunk, stream-extracts the runtime without writing
an oversized intermediate archive, and verifies the launcher version without
accessing the network or modifying the user profile. Set
`GITNEXUS_KOTLIN_LSP_BIN` to an absolute launcher path only when a centrally
managed runtime must override the bundled version. Each indexing session
receives an isolated temporary Kotlin LSP system/cache directory which is
removed during adapter shutdown.

The Kotlin LSP currently supports JVM projects modeled by Gradle or Maven. A
loose `.kt` file can still return useful semantics, but a production repository
should retain its real build files so dependency resolution is authoritative.

## Production indexing flow

The standalone commands below are diagnostic clients. Production indexing is
started only through the repository-level launcher:

```bash
./lsp-link index /path/to/repository
```

The launcher installs missing bundled tools, prepares and validates Bazel build
models, computes the content-addressed crawl identity, and then asks this
package's adapter registry to serve only cache-miss semantic partitions. The
indexer owns normalization, artifact enrichment, bulk graph loading, and final
publication; `lsp_server` owns adapter selection, process lifecycle, protocol
backpressure, and shutdown.

```text
index -> prepare-build-model -> crawl cache lookup
      -> LSP adapters on cache misses -> normalize/enrich -> publish graph
```

An existing Bazel build is automatically useful as an action-cache warm-up.
It is not a separate indexer stage and does not replace the scoped aspect build
that produces the indexer handoff.

---

## 1. Start via Shell Script
```bash
./lsp_server/start_server.sh sample_projects/spring-boot-demo
```

## 2. Start via TypeScript
```bash
npm run server -- ../sample_projects/spring-boot-demo
```

---

## 3. Direct LSP Query Client (`query.ts`)
You can query the LSP server directly from this folder without going through GitNexus:

```bash
cd lsp_server

# 1. Outgoing / Incoming Call Hierarchy Tree:
npm run query -- calls ../sample_projects/spring-boot-demo --symbol showExecutionHistory

# 2. Interface to Concrete Implementations:
npx tsx query.ts impl ../sample_projects/spring-boot-demo --symbol DemoWorkflow

# 3. 360-Degree Compiler Context:
npx tsx query.ts context ../sample_projects/spring-boot-demo --symbol DemoWorkflow
```

---

## Capabilities
- **Runtime**: OpenJDK 21+, selected from the project's declared Java level when available
- **Transport**: JSON-RPC 2.0 over `stdio`
- **Compiler Backends**: native Gradle and Maven import; Bazel external project models
- **Standard Protocol**: LSP 3.16+ (`documentSymbol`, `prepareCallHierarchy`, `implementation`, `hover`)

## Session and resource ownership

Each language is registered through an adapter factory. The registry creates
one adapter per workspace, coalesces concurrent startup calls for the same
session, and owns cleanup after partial startup. Adapter-declared extensions
are the sole routing catalog used by both the query CLI and production indexer;
there is no second extension switch in the CLI.

The base stdio adapter enforces `maxConcurrentRequests`, bounds retained
diagnostic notifications, limits opened document size, propagates protocol
failures, and caps initialize, query, and shutdown waits. JDT workspaces are
run-scoped and removed after the owning shard stops, so simultaneous indexing
runs cannot delete each other's compiler state.

Each active server session also maintains a bounded 2,048-entry LRU for
read-only semantic RPCs. Its key is the LSP method plus canonicalized parameters,
including the exact document URI and position. Concurrent identical requests
share one promise, successful responses are reused, failures are immediately
evicted, and the cache is cleared at session start and shutdown. Declaration
reference coverage provides the cross-position optimization: one class-level
`textDocument/references` result can cover thousands of usages without caching
by unsafe lexical class names.

JDT process count is constrained by both crawl concurrency and a total heap
budget. `GITNEXUS_JDT_MAX_TOTAL_HEAP_GB` defaults to `8`; the planner reduces
the shard count until the aggregate 2/4/6 GB JVM heaps fit. Override
`GITNEXUS_JDT_CLASSPATH_READY_TIMEOUT_MS` (default `180000`) when an unusually
large import needs more time. A classpath that is still incomplete at that
deadline fails the shard instead of being mislabeled as a complete crawl.

JDT LS has one normalized protocol quirk: for `typeDefinition` on Java
primitives and synthetic `array.length`, some versions emit a response with
neither `result` nor `error`. These constructs have no navigable declaration,
so the Java adapter converts that exact envelope to the valid nullable result
`null`. It does not suppress any other JDT LS errors.

## Java build import

### Spring Tools

Java sessions optionally start the official Spring Boot Language Server beside
JDT.LS and load its JDT extension bundles. Install it once with:

```bash
bash lsp_server/scripts/install-spring-tools.sh
```

The runtime is discovered from the GitNexus cache, installed VS Code/Cursor
extensions, or `GITNEXUS_SPRING_TOOLS_HOME`. Set `GITNEXUS_SPRING_TOOLS=false`
to disable it. Spring Tools receives its Java type and classpath answers through
the matching build-root-scoped JDT.LS session.

For Bazel, the Java adapter generates `.gitnexus/jdtls/bazel-project.json`
before JDT.LS starts. Spring's bean index then receives the same exact configured
classpath as Java compilation.

Build systems are detected independently, including mixed repositories and nested Maven or Gradle modules.
Gradle is imported through Buildship and Maven through M2E. Bazel does not have a native JDT.LS importer,
so GitNexus runs a configured `bazel cquery`, selects every target exposing
`JavaInfo.transitive_compile_time_jars`, and atomically writes this external model:

```json
{
  "javaMajor": 25,
  "sourcePaths": ["src/main/java"],
  "classpath": ["bazel-out/path/to/compile-time.jar"],
  "runtimeClasspath": ["bazel-out/path/to/full-runtime.jar"],
  "sourceInventoryPath": ".gitnexus/jdtls/bazel-source-inventory.json"
}
```

Classpath entries may be absolute or relative to the workspace; source and output paths must stay inside the
workspace. The classpath must contain the exact compile-time jars
reported by Bazel's `JavaInfo`; scanning every jar under `bazel-bin` is intentionally unsupported because it
produces an inaccurate dependency graph. Source analysis is refreshed through a Bazel aspect on every
preparation (Bazel keeps the work incremental), and the sidecar records configured target ownership,
generated/source-JAR sources, content deduplication, and repository-only files. Crawling uses the union of
that configured inventory and every checked-in Java file. Set `GITNEXUS_JDT_BAZEL_PROJECT_MODEL` to use a
pre-generated classpath manifest; GitNexus leaves it unchanged and generates the source sidecar beside it.
Source JAR materialization deduplicates identical archives globally, validates and reuses completed cache
entries, and extracts with bounded concurrency and a per-JAR timeout. Override the defaults with
`GITNEXUS_BAZEL_SOURCE_JAR_CONCURRENCY` (default `4`, maximum `16`) and
`GITNEXUS_BAZEL_SOURCE_JAR_TIMEOUT_MS` (default `120000`).
Main-repository source JARs participate in the JDT document inventory; external dependency source JARs
remain artifact provenance and are not extracted as project documents. Bazel 8 `@@//` main-repository
labels are safely joined with `//` query labels without altering external repository identities.
The source aspect accepts both public compatibility and private `rules_java` `JavaInfo` provider identities,
which supports repositories that mix standard Java rules with custom Java-producing rules.

The public `./lsp-link index <workspace>` command runs the required Bazel
preparation before indexing and emits `.gitnexus/jdtls/bazel-handoff.json`
last. Its subsequent `build-index` stage performs no Bazel command in prepared
mode. The handoff is accepted only when the build configuration, model,
inventory, classpath/source JAR hashes, and all crawl source hashes still
match. Advanced operators can invoke `prepare-build-model` and `build-index`
directly when diagnosing stage boundaries. Set `GITNEXUS_JDT_BAZEL_HANDOFF`
for a non-default same-workspace handoff path.

Imports are enabled by default. Use `GITNEXUS_JDT_IMPORT=0` globally, or
`GITNEXUS_JDT_GRADLE_IMPORT`, `GITNEXUS_JDT_MAVEN_IMPORT`, and `GITNEXUS_JDT_BAZEL_IMPORT`
for provider-specific control. `GITNEXUS_JDT_JAVA_HOME` explicitly selects the JDT runtime.

Provider configuration is passed through without repository edits:

- Gradle: `GITNEXUS_JDT_GRADLE_ARGUMENTS`, `GITNEXUS_JDT_GRADLE_USER_HOME`, and `GITNEXUS_JDT_GRADLE_OFFLINE`.
- Maven: `GITNEXUS_JDT_MAVEN_USER_SETTINGS`, `GITNEXUS_JDT_MAVEN_GLOBAL_SETTINGS`, and `GITNEXUS_JDT_MAVEN_OFFLINE`.
- Bazel: `GITNEXUS_JDT_BAZEL_PROJECT_MODEL`, `GITNEXUS_BAZEL_BIN`,
  `GITNEXUS_JDT_BAZEL_TARGETS`, `GITNEXUS_JDT_BAZEL_HANDOFF`, `GITNEXUS_JDT_BAZEL_MODEL_TIMEOUT_MS`, and
  `GITNEXUS_JDT_BAZEL_AUTO_MODEL=0` to disable generation.

The separate JVM artifact-enrichment stage consumes normalized descriptors
from an `ArtifactClasspathProvider` registry. Bazel uses the generated
compile/runtime `JavaInfo` model; Maven and Gradle use the classpaths actually
imported by M2E and Buildship through JDT LS; generic JDT and explicit JSON
manifest providers cover unmanaged and externally modeled projects. Use
`--artifact-classpath-manifest` for an additional manifest and
`--artifact-max-classes` only when a bounded dependency crawl is desired.
Artifact bytecode is parsed without classloading by one persistent ASM worker;
`--artifact-concurrency` controls its parsing threads and is capped at 16.

### Poly-build monorepositories

The registry discovers independent build roots before starting Java language servers:

- every Gradle `settings.gradle(.kts)` root, plus standalone Gradle builds outside those roots;
- Maven reactor roots, with `<modules>` children kept in the parent reactor;
- every nested Bazel `MODULE.bazel`, `WORKSPACE`, or `WORKSPACE.bazel`;
- one unmanaged fallback root for Java files outside all detected builds.

Each Java file is assigned to its nearest build root. The registry distributes roots over a bounded pool of
persistent multi-project JDT.LS processes (four by default). Every Bazel root becomes a linked Eclipse project
whose `.classpath` is generated from its exact `JavaInfo` model. Maven and Gradle roots remain native workspace
folders while M2E or Buildship import is available; an existing Eclipse `.classpath` is the external-model
fallback when native import is disabled. Unmanaged roots receive source-only Eclipse projects.

Each logical `LspServer` remains root-scoped and records `processShardId`, while documents retain their original
`buildRootId`. Before crawling, a shard waits for `java.project.getAll` to expose every expected project and
resolves each runtime classpath. This preserves queryable project ownership even though several projects share
one physical process, and avoids results depending on an unfinished JDT import.

Before those memory-bounded JDT shards start, Bazel classpaths are prepared concurrently. The default pool
contains four Bazel processes and the repository-wide preparation budget is ten minutes. Override these with
`GITNEXUS_JDT_BAZEL_PREPARE_CONCURRENCY` and `GITNEXUS_JDT_BAZEL_PREPARE_TIMEOUT_MS`. A failed or timed-out
root is recorded as failed without blocking successful roots, and cached roots normally complete immediately.
