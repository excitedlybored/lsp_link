# LSP Link

LSP Link crawls source repositories through language servers and persists the
observed semantic model in LadybugDB. Protocol observations remain first-class:
symbols use the 26 standard LSP symbol kinds, call-site ranges are retained,
and definitions, implementations, diagnostics, hover, semantic tokens, and
signature help have structured storage.

## Packages

```text
lsp_server/  language-server adapters, protocol contracts, and build import
indexer/     crawl orchestration, artifact enrichment, and LadybugDB writes
analyzer/    read-only Python queries and semantic extractors
```

The dependency direction is deliberate:

```text
lsp_server -> protocol responses
                  |
                  v
indexer -> normalized LSP/JVM observations -> *.lbug
                                              |
                                              v
analyzer -> evidence queries and semantic extraction
```

Semantic extractors do not alter the canonical crawl. The Temporal extractor
lives under `analyzer/extractors/temporal`; Kafka and Spring extractors can be
added as siblings.

Extractor inputs are restricted to LadybugDB. Detection uses stable framework
class, annotation, and method identities; repository paths and fixed source
coordinates are not valid semantic criteria.

Semantic type declarations are resolved against `JvmClass` nodes from compiled
dependency artifacts before extraction. `LspJvmBinding` relationships connect
LSP hovers, symbols, and occurrences to those bytecode identities; extractors
do not identify frameworks from hover text or URI substrings. Dependency
sources are optional.

## Index a repository

```bash
npm install
npm run index -- build /path/to/repository \
  --output /tmp/repository.lbug \
  --concurrency 4 \
  --artifact-concurrency 4
```

Java repositories may contain independent Bazel, Maven, Gradle, and unmanaged
build roots. Each source is assigned to its nearest root and each root gets an
isolated language-server session. Bazel classpaths are derived from `JavaInfo`;
Maven and Gradle use the models imported by M2E and Buildship.

After the protocol crawl, a separate JVM artifact stage associates header,
binary, and source JARs and records bytecode-derived classes and calls in the
`Jvm*` schema. It never represents artifact evidence as an LSP response.

The output path must not already exist. Build outputs are retained after each
root finishes; cleanup is an explicit operator decision.

The indexer writes atomic intermediate checkpoints beside the output (for
example, `/tmp/repository.lbug.checkpoints`). Each completed build root, the
merged LSP crawl, logical-call normalization, and JVM artifact enrichment are
saved independently. Repeating the same command resumes compatible work and,
after a database-open or persistence failure, retries only LadybugDB writing.
Source and build-file changes invalidate stale crawl checkpoints. Use
`--checkpoint-directory PATH` to relocate them or `--no-resume` to deliberately
start a fresh run while still replacing checkpoints with the new results.

## Query and analyze

```bash
uv pip install -r analyzer/requirements.txt
npm run graph:summary -- /tmp/repository.lbug
npm run extract -- /tmp/repository.lbug --extractor temporal
LBUG_REPO=/tmp/repository.lbug npm run mcp:analyzer
```

The analyzer opens LadybugDB read-only. Its OpenCypher entry point rejects
write clauses.

## Development

```bash
npm run build
npm test
```

See [`indexer/README.md`](indexer/README.md),
[`lsp_server/README.md`](lsp_server/README.md), and
[`analyzer/README.md`](analyzer/README.md) for package-specific details.
