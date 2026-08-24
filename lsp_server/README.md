# Set 1: Standalone LSP Server Daemon (`lsp_server/`)

This directory contains the standalone server launcher for **Eclipse JDT Language Server (`eclipse.jdt.ls`)**.

---

## 1. Start via Shell Script
```bash
./lsp_server/start_server.sh sample_projects/spring-boot-demo
```

## 2. Start via TypeScript
```bash
npx tsx lsp_server/server_launcher.ts sample_projects/spring-boot-demo
```

---

## 3. Direct LSP Query Client (`query.ts`)
You can query the LSP server directly from this folder without going through GitNexus:

```bash
cd lsp_server

# 1. Outgoing / Incoming Call Hierarchy Tree:
npx tsx query.ts calls ../sample_projects/spring-boot-demo --symbol showExecutionHistory

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
  "outputPath": "bazel-out/classes"
}
```

Classpath entries may be absolute or relative to the workspace; source and output paths must stay inside the
workspace. The classpath must contain the exact compile-time jars
reported by Bazel's `JavaInfo`; scanning every jar under `bazel-bin` is intentionally unsupported because it
produces an inaccurate dependency graph. The generated model is reused until a `MODULE.bazel`, workspace,
BUILD, or `.bazelrc` file changes. Set `GITNEXUS_JDT_BAZEL_PROJECT_MODEL` to use a pre-generated manifest.

Imports are enabled by default. Use `GITNEXUS_JDT_IMPORT=0` globally, or
`GITNEXUS_JDT_GRADLE_IMPORT`, `GITNEXUS_JDT_MAVEN_IMPORT`, and `GITNEXUS_JDT_BAZEL_IMPORT`
for provider-specific control. `GITNEXUS_JDT_JAVA_HOME` explicitly selects the JDT runtime.

Provider configuration is passed through without repository edits:

- Gradle: `GITNEXUS_JDT_GRADLE_ARGUMENTS`, `GITNEXUS_JDT_GRADLE_USER_HOME`, and `GITNEXUS_JDT_GRADLE_OFFLINE`.
- Maven: `GITNEXUS_JDT_MAVEN_USER_SETTINGS`, `GITNEXUS_JDT_MAVEN_GLOBAL_SETTINGS`, and `GITNEXUS_JDT_MAVEN_OFFLINE`.
- Bazel: `GITNEXUS_JDT_BAZEL_PROJECT_MODEL`, `GITNEXUS_BAZEL_BIN`,
  `GITNEXUS_JDT_BAZEL_TARGETS`, `GITNEXUS_JDT_BAZEL_MODEL_TIMEOUT_MS`, and
  `GITNEXUS_JDT_BAZEL_AUTO_MODEL=0` to disable generation.

### Poly-build monorepositories

The registry discovers independent build roots before starting Java language servers:

- every Gradle `settings.gradle(.kts)` root, plus standalone Gradle builds outside those roots;
- Maven reactor roots, with `<modules>` children kept in the parent reactor;
- every nested Bazel `MODULE.bazel`, `WORKSPACE`, or `WORKSPACE.bazel`;
- one unmanaged fallback root for Java files outside all detected builds.

Each Java file is assigned to its nearest build root. JDT.LS sessions run sequentially per root with separate
workspace data and nested foreign roots excluded from import. This bounds memory and prevents Maven, Gradle,
or Bazel classpaths from leaking into one another. Persisted LSP relationships include structured build-root
and build-system evidence.

Before those memory-bounded JDT sessions start, Bazel classpaths are prepared concurrently. The default pool
contains four Bazel processes and the repository-wide preparation budget is ten minutes. Override these with
`GITNEXUS_JDT_BAZEL_PREPARE_CONCURRENCY` and `GITNEXUS_JDT_BAZEL_PREPARE_TIMEOUT_MS`. A failed or timed-out
root is recorded as failed without blocking successful roots, and cached roots normally complete immediately.
