# LadybugDB data model

The writer in `indexer/` persists two evidence families in one LadybugDB
database while keeping their provenance and relation tables separate.

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

## JVM artifact model

The post-crawl artifact stage writes `JvmArtifactEnrichmentRun`, `JvmArtifact`,
`JvmClass`, `JvmMethod`, `JvmField`, and `JvmCallSite` nodes. `JvmRelation`
stores containment, inheritance, interface, declaration, and bytecode-call
facts. Artifact-derived evidence is never written as an `LspRelation`.

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

Schema DDL lives in `indexer/src/lbug/schema.ts` and
`indexer/src/artifact/schema.ts`. The analyzer opens the database read-only.
