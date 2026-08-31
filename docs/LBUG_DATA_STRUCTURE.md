# LadybugDB data model

The writer in `indexer/` persists four evidence families in one LadybugDB
database while keeping their provenance and relation tables separate.

## How the database is produced

The graph is the final publication of the single automated indexing workflow:

```text
./lsp-link index REPOSITORY
  -> prepare and validate the scoped build model
  -> inventory documents and reuse/run the content-addressed LSP crawl
  -> normalize logical calls and stream JVM artifact facts
  -> bulk-copy repository, Bazel, LSP, derived, and JVM evidence
  -> atomically publish REPOSITORY/.gitnexus/lsp-lbug
```

An earlier Bazel build may warm Bazel's action cache, but it is not a separate
required stage and does not produce the indexer handoff. Cache hits preserve
the same evidence families and provenance as a freshly executed crawl.

## Bazel configured build model

Successful Bazel preparation writes `BazelBuildGraphRun`, `BazelTarget`,
`BazelSource`, and `BazelArtifact` nodes. `BazelRelation` retains direct
`deps`, `exports`, `runtime_deps`, and `plugins` edges, source ownership, and
the compile/runtime/source artifact roles observed for each selected target.
Dependency labels outside the selected query remain explicit placeholder
targets (`selected = false`) instead of disappearing from the graph.
`BazelBuildGraphRun` also records the semantic scope hash, selectors, resolved
target count, and excluded labels with reasons so the graph's boundary is
auditable.

This model is configured-build evidence and remains separate from LSP and JVM
relations. It records why an artifact entered the classpath without claiming
that Bazel configuration edges were language-server observations.

## LSP protocol model

- `LspAnalysisRun`, `LspBuildRoot`, and `LspServer` record crawl provenance.
- `LspDocument` records opened workspace and external documents.
- The 26 `Lsp*Symbol` tables map directly to the standard `SymbolKind` values.
- `LspCallSite` retains every call-hierarchy `fromRange` independently.
- `LspOccurrence` stores definition, declaration, reference, implementation,
  and type-hierarchy locations without inventing language semantics.
- `LspHover`, `LspDiagnostic`, `LspSemanticToken`, `LspSignatureHelp`,
  `LspSignature`, and `LspParameter` preserve structured capability results.
- `LspCoverage` records unsupported, excluded, empty, failed, timed-out,
  observed, mapped, and unmapped outcomes.

`LspRelation` carries run, server, capability, mapping status, provider
authority, mapping confidence, raw/derived status, reason, and ordinal. A call
is modeled as:

```text
Lsp*Symbol -[HAS_CALLSITE]-> LspCallSite -[RESOLVES_TO]-> Lsp*Symbol
```

## Derived logical-call model

Incoming and outgoing call-hierarchy responses may observe the same source
invocation independently. The post-crawl normalization stage writes
`DerivedCallNormalizationRun`, `LspLogicalInvocation`, and
`DerivedCallRelation` without altering raw `LspCallSite` observations. Stable
logical identity includes the caller, target implementation family, source
document, and exact invocation range. Provider disagreement remains visible.

## JVM artifact model

The post-crawl persistent ASM stage writes `JvmArtifactEnrichmentRun`, `JvmArtifact`,
`JvmClassResolution`, `JvmClass`, `JvmMethod`, `JvmField`, and `JvmCallSite` nodes. `JvmRelation`
stores containment, inheritance, interface, declaration, and bytecode-call
facts. Artifact-derived evidence is never written as an `LspRelation`.
`LspJvmBinding` connects LSP observations to exact `JvmClass` or `JvmMethod`
identities without representing bytecode evidence as an LSP response.

## Example queries

```cypher
MATCH (caller)-[:LspRelation {kind: 'HAS_CALLSITE'}]->(site:LspCallSite)
OPTIONAL MATCH (site)-[:LspRelation {kind: 'RESOLVES_TO'}]->(callee)
RETURN caller.name, site.startLine, site.startCharacter, callee.name;
```

```cypher
MATCH (coverage:LspCoverage)
RETURN coverage.capability, coverage.status, coverage.failureCount,
       coverage.timeoutCount;
```

```cypher
MATCH (artifact:JvmArtifact)-[:JvmRelation {kind: 'CONTAINS_CLASS'}]->(class:JvmClass)
RETURN artifact.coordinate, class.binaryName;
```

```cypher
MATCH (site:LspCallSite)-[:DerivedCallRelation {kind: 'NORMALIZES_TO'}]->(call:LspLogicalInvocation)
RETURN call.stableKey, call.observationCount, call.status;
```

```cypher
MATCH (owner:BazelTarget)-[edge:BazelRelation {kind: 'DEPENDS_ON'}]->(dependency:BazelTarget)
RETURN owner.label, edge.attribute, dependency.label;
```

Schema DDL lives in `indexer/src/lbug/schema.ts`,
`indexer/src/derived/call-normalization/schema.ts`, and
`indexer/src/artifact/schema.ts`, and `indexer/src/bazel/schema.ts`. The
analyzer opens the database read-only.
