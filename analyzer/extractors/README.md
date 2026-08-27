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
manifest. `applicabilitySemanticTypes` identifies the framework anchors whose
absence from a complete index makes the result `not_applicable` rather than an
error. Other absent semantic types can represent API-version differences and
are reported without preventing extraction. The enrichment stage resolves JDT
external URIs once and persists `LspJvmBinding` relationships; evidence queries
traverse those bindings rather than parsing hover content or dependency URI
strings. Compiled dependency JARs are sufficient for this check; source JARs
are optional enrichment.

JVM semantic identities are resolved through `JvmClassResolution`, whose
`classId` and `artifactId` identify the class selected by classpath precedence.
Extractors must not choose an arbitrary `JvmClass` by binary name or infer an
SDK from every class co-located with an anchor. Databases without the resolution
table are incompatible with semantic extraction and fail with an explicit
missing-table error instead of silently falling back.

Every manifest also declares `completenessRequirements`: health tables and the
exact LSP capabilities its conclusions depend on. A missing health signal does
not make an older compatible database unreadable; it makes the report
`partial` and records the limitation explicitly.

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

Every report has a top-level `qualification` and an `indexHealth` section. The
health record selects the newest analysis run and scopes Bazel roots, artifact
enrichment, and capability coverage to that run. It exposes analysis errors and
timeouts, failed Bazel roots, artifact truncation and errors, relevant LSP
coverage counters, framework applicability, and human-readable limitations.

`complete` means the selected analysis and artifact runs completed, all Bazel
roots were ready, and every relevant capability has only `mapped` or successful
`empty` coverage. `partial` means a required signal is missing or degraded;
findings remain evidence-backed, but absence is not conclusive.
`not_applicable` is emitted only when health is complete and none of the
framework anchor semantic types is present. Thus a partial index never turns
"zero workflows" into a false absence claim.

## Adding an extractor

Create `<name>/manifest.json`, place each query in `queries/*.cypher`, and
provide an `assemble(results)` function when grouped raw evidence is not enough.
The manifest declares evidence tables required to run its queries, so
incompatible graphs fail before extraction begins. Completeness tables are
soft requirements that qualify the report as partial when unavailable. The
loader also rejects write queries,
repository-specific literals, fixed source-position comparisons, and semantic
identity matching through unstructured hover or URI text.
