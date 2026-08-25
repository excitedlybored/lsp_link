# Command reference

Run all commands from the repository root after `./install.sh` unless noted.

## Install

```bash
./install.sh
```

This uses the checked-in `vendor/npm` tarballs with `npm ci --offline`; it does
not contact Artifactory or another npm registry.

## Build a knowledge graph

```bash
npm run index -- build /path/to/repository \
  --output /tmp/repository.lbug \
  --concurrency 4 \
  --artifact-concurrency 4
```

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
