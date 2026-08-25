# Semantic extractors

This folder contains read-only, framework-specific semantic extraction over the
LSP-native LadybugDB schema. Extractors never parse source or mutate the
database. Their OpenCypher queries gather auditable evidence; an assembler
turns that evidence into higher-level framework concepts.

Every manifest must declare `dataSource: ladybugdb-only` and
`identityPolicy: framework-semantic-identities`. Framework API classes,
annotations, and methods are stable semantic identities. Repository paths,
application-specific names, and fixed line or character numbers are rejected.
Source positions may be returned as observations, but never determine identity
through a hard-coded coordinate.

Framework meaning is declared once as a `semanticTypes` ontology in the
manifest. Before extraction, every declared binary name must resolve to an
actual `JvmClass` in LadybugDB. The enrichment stage resolves JDT external URIs
once and persists `LspJvmBinding` relationships; evidence queries traverse
those bindings rather than parsing hover content or dependency URI strings.
Compiled dependency JARs are sufficient for this check; source JARs are
optional enrichment.

## Layout

```text
analyzer/extractors/
  core.py                    generic extraction pipeline
  run.py                     CLI
  temporal/
    manifest.json            metadata and ordered evidence queries
    queries/*.cypher         inspectable LadybugDB evidence queries
    assembler.py             builds workflows from query evidence
```

Kafka, Spring, gRPC, and persistence extractors belong in sibling directories.
Each can reuse the pipeline while retaining its own vocabulary, queries,
confidence model, and assembler.

## Temporal

```bash
uv run --with-requirements analyzer/requirements.txt \
  python -m analyzer.extractors.run \
  /tmp/bazel-springboot-temporal-kafka-40-final.lbug \
  --extractor temporal \
  --output /tmp/temporal-workflows.json
```

The Temporal extractor combines independent evidence:

- enriched `io.temporal.*` JVM classes establish dependency presence;
- annotation hovers bound to exact `JvmClass` identities confirm
  workflow/activity contracts and method roles;
- workflow contracts are confirmed by `@WorkflowInterface` or a contained
  `@WorkflowMethod`, avoiding application naming conventions;
- `IMPLEMENTATION_OF` maps contracts and methods to concrete classes;
- `LspCallSite` plus `RESOLVES_TO` preserves every invocation range;
- resolved Temporal SDK calls identify stub creation, starts, worker
  registration, signals, queries, and other runtime operations.

Use `--include-raw` to include every evidence-query row. Without it, the report
contains assembled workflows and an `evidenceQueryCounts` audit trail.

## Adding an extractor

Create `<name>/manifest.json`, place each query in `queries/*.cypher`, and
provide an `assemble(results)` function when grouped raw evidence is not enough.
The manifest declares required LadybugDB tables, so incompatible graphs fail
before extraction begins. The loader also rejects write queries,
repository-specific literals, fixed source-position comparisons, and semantic
identity matching through unstructured hover or URI text.
