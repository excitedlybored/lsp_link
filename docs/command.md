# Command reference

Run all commands from the repository root after `./install.sh` unless noted.
Use Node.js 20.17+ or 22.9+ with npm 9.2+. Python analyzer setup requires
`uv` and `python3.12` on `PATH`.

## Install

```bash
./install.sh
```

This uses the checked-in `vendor/npm` tarballs with `npm ci --offline`; it does
not contact Artifactory or another npm registry. It also verifies the bundled
Eclipse JDT.LS runtime in `vendor/jdtls/1.57.0`; install only a JDK 21+ to use
Java indexing.

## Build a knowledge graph

```bash
npm run index -- build /path/to/repository \
  --output /tmp/repository.lbug \
  --concurrency 4 \
  --artifact-concurrency 4
```

For enterprise Bazel repositories, run preparation in the user-controlled
environment that has Artifactory credentials:

```bash
npm run index -- bazel-prepare /path/to/repository
# Equivalent direct script:
npm run bazel:prepare -- /path/to/repository
```

Preparation owns every Bazel command and writes a hashed handoff at
`.gitnexus/jdtls/bazel-handoff.json`. Index later without invoking Bazel:

```bash
npm run index -- build /path/to/repository \
  --bazel-build-mode prebuilt \
  --output /tmp/repository.lbug
```

`prebuilt` validates the configuration fingerprint, project model, source
inventory, classpath/source JARs, and every repository/generated/analysis
source. Missing or changed inputs fail the Bazel root and require preparation
again. The default `managed` mode retains the integrated behavior.

If the user already ran `bazel build`, preparation reuses Bazel's incremental
outputs. It still runs configured queries and materializes the source aspect,
because ordinary build outputs do not contain GitNexus's target/source
inventory. The preparation and indexing commands currently share the same
workspace and Bazel output cache; cleaning or relocating either invalidates the
handoff.

The default `legacy` crawl planner preserves the original request schedule.
The opt-in facts-first planner collects declaration-scoped references across a
complete build root before querying semantic-token gaps:

```bash
npm run index -- build /path/to/repository \
  --output /tmp/repository-facts.lbug \
  --crawl-planner facts-first
```

Planner mode is part of the checkpoint fingerprint, so legacy results cannot
be resumed accidentally by a facts-first crawl. To compare their independently
derived semantic inventories, retain separate checkpoint directories and run:

```bash
npm run compare:crawls -- \
  /tmp/repository-legacy.lbug.checkpoints/lsp-crawl.checkpoint \
  /tmp/repository-facts.lbug.checkpoints/lsp-crawl.checkpoint \
  --output /tmp/repository-crawl-comparison.json
```

The command exits unsuccessfully when documents, symbols, reference
occurrences, call sites, implementation/type relations, diagnostics, semantic
tokens, or signature inventories differ. Raw request-specific definition,
declaration, and hover observations are reported in the batch counts but are
not treated as semantic inventory differences.

`--concurrency` is the number of persistent JDT LS shards. The separate
`--artifact-concurrency` limits parallel JVM bytecode disassembly. The output
path must be new.

Useful options:

```bash
# Store checkpoints outside the output directory.
npm run index -- build /path/to/repository \
  --output /tmp/repository.lbug \
  --checkpoint-directory /tmp/repository-checkpoints

# Discard compatible checkpoints and start a new crawl.
npm run index -- build /path/to/repository \
  --output /tmp/repository.lbug \
  --no-resume
```

## Read and extract from an `.lbug`

```bash
# High-level graph summary.
npm run graph:summary -- /tmp/repository.lbug

# Typed read-only graph client.
npm run lbug:read -- /tmp/repository.lbug

# Run the Temporal semantic extractor.
npm run extract -- /tmp/repository.lbug --extractor temporal

# Start the read-only OpenCypher MCP server.
LBUG_REPO=/tmp/repository.lbug npm run mcp:analyzer
```

The analyzer does not mutate the database. Its MCP server rejects write
OpenCypher clauses.

## Query a language server directly

```bash
# Outgoing or incoming call hierarchy.
npm run query -- calls sample_projects/spring-boot-demo \
  --symbol DemoWorkflow --direction outgoing --depth 3

# Implementations of a symbol.
npm run query -- impl sample_projects/spring-boot-demo --symbol DemoWorkflow

# Hover or context information.
npm run query -- hover sample_projects/spring-boot-demo --symbol DemoWorkflow
npm run query -- context sample_projects/spring-boot-demo --symbol DemoWorkflow
```

Use `--file`, `--line`, and `--char` to select a source location. The query
CLI also accepts `--format tree|json|mermaid` and `--language <server>`.

## Development

```bash
npm run build
npm test
```

## Maintain vendored npm dependencies

This is only needed after intentionally changing dependency tarballs in
`vendor/npm`:

```bash
node scripts/vendor-lock.mjs
npm ci --offline
```

The script verifies the complete lockfile closure, records local tarball paths
and integrity hashes, and preserves LadybugDB native packages for supported
platforms.
