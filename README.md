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
analyzer/    read-only Python queries and scalable rule packs
```

The dependency direction is deliberate:

```text
lsp_server -> protocol responses
                  |
                  v
indexer -> normalized LSP/JVM observations -> *.lbug
                                              |
                                              v
analyzer -> OpenCypher queries and rule-based interpretations
```

Framework rules do not alter the canonical crawl. Temporal rules currently
live under `analyzer/rules/packs/temporal`; Kafka and Spring rules can be added
as sibling packs.

## Index a repository

```bash
npm install
npm run index -- build /path/to/repository \
  --output /tmp/repository.lbug \
  --concurrency 4
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

## Query and analyze

```bash
uv pip install -r analyzer/requirements.txt
npm run graph:summary -- /tmp/repository.lbug
npm run rules:analyze -- /tmp/repository.lbug --pack temporal
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
