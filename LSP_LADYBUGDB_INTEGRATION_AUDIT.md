# LSP–LadybugDB Integration Audit

## Status

This is a historical design audit. It records assumptions that motivated the
LSP-native redesign; statements in the numbered findings describe the removed
parser-owned implementation, not the current repository. The active system is
split across `lsp_server/`, `indexer/`, and `analyzer/` and is documented in
their package READMEs.

The redesign now provides direct symbol classes, call-site nodes, structured
capability observations, per-capability coverage, build-root/server provenance,
logical-call normalization, JVM artifact evidence, LSP-to-JVM bindings,
persistent JDT shards, and resumable stage checkpoints. Claims such as
"compiler ground truth" or universal precision remain inappropriate: negotiated
capabilities, mapping coverage, diagnostics, and extractor evidence must be
reported for each run.

## Historical Data Flow (removed)

```text
Legacy parser crawl
  -> AST symbols and heuristic relationships
  -> LSP enrichment of selected CALLS and IMPLEMENTS relationships
  -> framework and scope-resolution phases
  -> communities and processes
  -> graph.json and LadybugDB
```

The active model now treats protocol servers, artifact analyzers, and framework
extractors as separate evidence providers. Raw LSP facts, derived calls, and
bytecode facts use separate provenance and relationship tables.

## Historical Invalid or Incomplete Assumptions

### 1. One canonical LSP implementation exists

It does not. There are duplicated adapter stacks under:

- `lsp_server/`
- the removed duplicate adapter stack

LadybugDB ingestion uses the isolated copy. Newer document-symbol, definition, and reference APIs added to `lsp_server/` are therefore not automatically available to the indexer.

### 2. LSP reconciles the final heuristic graph

It does not. The current full-pipeline order places LSP before several phases that subsequently add or derive relationships:

```text
parse
  -> LSP enrichment
  -> routes / tools / ORM
  -> cross-file analysis
  -> scope resolution
  -> Spring analysis / MRO / DI
  -> communities / processes
```

Scope resolution can emit heuristic `CALLS` relationships after LSP conflict resolution has finished. LSP therefore cannot reconcile the final call graph.

### 3. LSP is integrated into the symbol model

It is not. The active enricher only adds:

- `CALLS`
- `IMPLEMENTS`

It does not persist or reconcile:

- document symbols;
- qualified names and containers;
- complete signatures and overload identities;
- definitions and declarations;
- references;
- type hierarchy;
- hover/type information;
- diagnostics;
- external symbols;
- individual call sites.

### 4. File path and simple name uniquely identify a symbol

They do not. The current graph index primarily matches a callable using:

```text
repository-relative file path + simple symbol name
```

The first matching node wins. This is insufficient for:

- overloads;
- multiple classes in one file;
- nested types;
- constructors;
- local functions;
- same-name methods in different containers;
- partial or generated declarations.

LSP supplies `uri`, `range`, `selectionRange`, `kind`, `detail`, and `containerName`, but most of this identity is discarded during mapping.

### 5. An implementation result can be mapped to the primary type in its file

This is unsafe. A file may contain multiple top-level or nested types. Mapping an LSP implementation location to `primaryTypeInFile()` can connect the wrong class or struct to an interface.

### 6. A caller-to-callee edge adequately represents a call

It does not preserve enough information. LSP `fromRanges` are discarded, so multiple call sites from one caller to the same target collapse into one relationship.

The persisted graph cannot reliably answer:

- where a call occurs;
- how many call sites exist;
- which expression produced the resolution;
- whether providers disagree about one particular call site;
- whether one overload was selected at one site and another elsewhere.

### 7. Current conflict pruning is precise

It is not. When LSP resolves a target, the current implementation removes heuristic calls from the same caller into the target file. This is broader than the corresponding call site or overload. The `keepTargetId` parameter is not used to preserve a matching target during this removal.

Conflict resolution also happens too early, before later heuristic phases emit their final edges.

### 8. Repository-local symbols are the complete semantic universe

They are not. LSP results outside the indexed repository are rejected. This drops relationships to:

- JDK and standard-library symbols;
- Maven and Gradle dependencies;
- npm dependencies;
- Python packages;
- SDKs and generated sources;
- other external libraries.

These results should become explicit external-symbol observations or nodes rather than disappearing.

### 9. An absent result means the compiler found no relationship

It does not. The current implementation commonly suppresses errors and returns an empty collection. The persisted result does not distinguish:

```text
unsupported capability
server unavailable
initialization failure
workspace still indexing
request timeout
request failure
successful empty response
successful response with unmapped target
successful mapped enrichment
```

### 10. `lspEnriched: true` means the graph contains LSP data

It currently means LSP was requested. It does not mean an adapter started or any observation was persisted.

Saved indexes demonstrate this problem:

- Python example: marked `lspEnriched: true`, with zero LSP relationships.
- TypeScript example: marked `lspEnriched: true`, with zero LSP relationships.
- Spring Boot demo: marked `lspEnriched: true`, with zero LSP relationships.

### 11. `confidence: 1.0` is equivalent to semantic truth

It is not. LSP responses can be partial, stale, workspace-configuration-dependent, or mapped incorrectly into the graph. At least three concepts are currently conflated:

- provider authority;
- identity-mapping confidence;
- semantic certainty.

These need separate fields or evidence records.

### 12. The `reason` string is sufficient provenance

It is not. Provider, method, version, ranges, mapping decision, workspace state, and analysis run are packed into or omitted from a free-form string.

The in-memory relationship type supports `evidence[]`, but the LadybugDB `CodeRelation` schema does not persist it.

### 13. Missing LSP edges can be interpreted safely

They cannot. There is no persisted coverage model showing:

- languages attempted;
- server availability and versions;
- server capabilities;
- files opened;
- symbols queried;
- successful, empty, failed, timed-out, and unmapped requests;
- excluded or unsupported files;
- enrichment percentage.

Without this information, absence of an LSP relationship is not negative knowledge.

### 14. All language servers support the same semantic workflow

They do not. Capabilities vary between servers and workspaces. The current integration does not model negotiated server capabilities as part of the analysis result and largely assumes that call hierarchy and implementation queries behave uniformly.

### 15. Generated and low-value files are safe enrichment targets

Not necessarily. Existing saved output includes LSP relationships from large generated or minified JavaScript resources. LSP target selection needs the same explicit source/generated/vendor policy as parsing, plus persisted reasons for exclusions.

### 16. A destructive edge upgrade preserves useful evidence

It does not. Deleting a heuristic relationship when LSP produces a different result destroys evidence about provider disagreement. Reconciliation should retain observations and derive a preferred projection.

### 17. Full database replacement provides adequate LSP lifecycle semantics

The former implementation did not address staleness or incremental provenance.
The active pipeline has persisted run identity and atomic stage/root
checkpoints. Document-level incremental recrawling and streamed canonical
database finalization remain future work.

## Isolated First-Class LSP Schema Decision

The implementation under `indexer/` now treats every standard
LSP `SymbolKind` as a physical LadybugDB node class. There is no catch-all
`LspSymbol` table:

```text
LspFileSymbol, LspModuleSymbol, LspNamespaceSymbol, LspPackageSymbol,
LspClassSymbol, LspMethodSymbol, LspPropertySymbol, LspFieldSymbol,
LspConstructorSymbol, LspEnumSymbol, LspInterfaceSymbol, LspFunctionSymbol,
LspVariableSymbol, LspConstantSymbol, LspStringSymbol, LspNumberSymbol,
LspBooleanSymbol, LspArraySymbol, LspObjectSymbol, LspKeySymbol,
LspNullSymbol, LspEnumMemberSymbol, LspStructSymbol, LspEventSymbol,
LspOperatorSymbol, LspTypeParameterSymbol
```

Each class retains the protocol kind, URI, tags, detail, complete zero-based
range, selection range, container, stable key, and external status. The row
boundary validates the numeric/name discriminator and routes the row to its
exact table. Relationship endpoints are expanded across concrete symbol
classes, including polymorphic implementation and neutral type-hierarchy facts.

Capability results remain first-class nodes rather than inferred symbol
properties: call sites, occurrences, diagnostics, hover responses, semantic
tokens, signature-help responses, signatures, parameters, and coverage.

The LSP tables remain a protocol-observation store. Logical calls are derived
into separate `LspLogicalInvocation` nodes, while JVM artifacts and semantic
extractors retain separate evidence boundaries rather than projecting into the
removed legacy `Class`/`Method` graph.

The isolated package now also provides the write path rather than DDL alone:

```text
capability task
  -> normalized observation batch
  -> explicit coverage outcome
  -> concrete symbol-table routing
  -> transactional LadybugDB write
```

The native repository was validated against LadybugDB 0.19.1 by creating a
fresh database, inserting a class and contained method, closing and reopening
the database, and querying the persisted `CONTAINS` relationship. Live adapter
orchestration remains responsible for scheduling request positions and passing
the resulting observation batches to this boundary.

## Target Knowledge Model

### Principle

Protocol servers, artifact analyzers, framework extractors, and heuristic
resolvers are evidence providers. They should not directly own canonical
semantic truth.

```text
Canonical Symbol
  <- OBSERVES - AST Observation
  <- OBSERVES - LSP Observation
  <- OBSERVES - Framework Observation

Caller
  -> HAS_CALLSITE -> CallSite
  -> RESOLVES_TO  -> Callee

CallSite
  <- SUPPORTS / CONTRADICTS - Evidence
```

The exact physical LadybugDB representation may use observation nodes, structured relationship properties, or a hybrid, but it must preserve provider-specific facts before deriving consolidated edges.

## Required Canonical Identity

A canonical source symbol needs enough information to distinguish declarations without relying on simple names:

- repository or workspace identity;
- normalized URI or repository-relative path;
- language;
- symbol kind;
- qualified/container name;
- signature or overload discriminator;
- declaration range;
- selection range;
- start and end columns;
- origin: source, generated, external, or synthetic.

Identity must account for edits and incremental indexing. A source location alone is a locator, not necessarily a durable identity.

## Required Call-Site Model

Representing only `caller -> CALLS -> callee` is insufficient for reconciliation. The model needs call-site identity containing at least:

- source file and precise range;
- enclosing canonical caller;
- source expression or stable hash;
- provider observations;
- candidate targets;
- selected target, if uniquely reconciled;
- ambiguity and mapping status.

A materialized `CALLS` relationship can remain as a fast derived projection for graph traversal.

## Required Provenance and Run Metadata

Every provider observation should be attributable to an analysis run with:

- provider type;
- adapter and server name;
- server version where available;
- language;
- workspace root;
- project/build configuration fingerprint;
- negotiated capabilities;
- start and completion timestamps;
- success, partial, failed, or unavailable status;
- query and mapping statistics;
- errors and timeout counts;
- content or commit fingerprint.

Provider authority and mapping confidence should be represented independently.

## Required Coverage Model

Coverage must be queryable per run, language, file, and capability. At minimum record:

- discovered eligible files;
- excluded files and reasons;
- attempted files;
- opened files;
- eligible symbols;
- queried symbols;
- successful queries;
- successful empty queries;
- unsupported queries;
- timeouts and failures;
- results mapped internally;
- results mapped externally;
- unmapped results.

The top-level manifest should use a status such as:

```text
not_requested | unavailable | failed | partial | complete
```

It should not use a boolean that reports intent rather than outcome.

## Required External-Symbol Model

Results outside the repository should not be discarded. The KB needs an external symbol representation containing, where available:

- URI;
- library/module/package identity;
- qualified name;
- signature;
- symbol kind;
- provider;
- source availability.

External symbols may be promoted to canonical internal symbols if their source later becomes part of an indexed workspace.

## Reconciliation Rules

1. Preserve raw observations before deriving consolidated relationships.
2. Reconcile at declaration and call-site granularity, not file granularity.
3. Never interpret a failed or unsupported query as a negative semantic fact.
4. Never delete conflicting evidence solely because another provider has higher authority.
5. Derive a preferred target only when identity and mapping rules support it.
6. Preserve ambiguity explicitly when multiple targets remain valid.
7. Keep compiler-reported and graph-mapped status separate.
8. Make every destructive or consolidating decision reproducible from persisted evidence.

## Corrected Pipeline Order

```text
1. Scan and parse source
2. Build AST symbols and explicit call sites
3. Run framework and scope resolution
4. Collect LSP observations
5. Reconcile LSP locations with canonical identities
6. Aggregate evidence and derive semantic projections
7. Validate and persist coverage/completeness
8. Build MRO, DI, communities, processes, CFG, and taint overlays
9. Persist graph plus analysis-run metadata
```

Some downstream analyses may need a more precise dependency split, but LSP reconciliation must see the final heuristic call candidates and communities/processes must consume the reconciled semantic projection.

## Migration Sequence

### Phase 0: Contract and fixtures

- Define the canonical identity, observation, call-site, provenance, coverage, and external-symbol contracts.
- Create golden fixtures for overloads, nested types, multiple types per file, constructors, external dependencies, dynamic proxies, generated sources, and partial server failure.
- Define what "complete" means per language and capability.

### Phase 1: Consolidate transport and adapters

- Remove the duplicated adapter implementations.
- Make both direct LSP queries and Ladybug ingestion consume one package.
- Persist negotiated capabilities and server identity.

### Phase 2: Truthful operational reporting

- Replace the `lspEnriched` boolean with an outcome status and coverage report.
- Stop swallowing failures without classification.
- Persist language/file/query/mapping metrics.

This can be implemented before changing graph semantics and will immediately prevent false claims of enrichment.

### Phase 3: Canonical locator and observation schema

- Add precise ranges, columns, qualified identity, signatures, and origin fields.
- Add analysis-run and provider observation storage.
- Introduce external symbols.

### Phase 4: Call-site reconciliation in shadow mode

- Preserve existing `CALLS` behavior.
- Build the new call-site and evidence model alongside it.
- Compare derived results against the legacy graph without deleting legacy edges.

### Phase 5: Correct pipeline ordering

- Run framework and scope inference before LSP reconciliation.
- Make communities, processes, and impact analysis consume the reconciled projection.

### Phase 6: Cutover and migration

- Switch query APIs to the derived semantic projection.
- Retain raw evidence for explanation and audit.
- Introduce an explicit schema fingerprint/migration boundary for existing indexes.
- Update analyzer queries, documentation, benchmarks, and claims.

## Acceptance Criteria

The integration should not be called complete until:

- one adapter implementation is used everywhere;
- overload and nested-symbol identity tests pass;
- call-site ranges survive into LadybugDB;
- external targets are retained;
- provider disagreements are explainable;
- LSP failures and empty results are distinguishable;
- coverage is persisted and queryable;
- `partial` versus `complete` enrichment is objectively defined;
- downstream communities and processes consume reconciled relationships;
- saved indexes can prove which compiler observations support each derived edge;
- golden comparisons validate persisted LadybugDB output, not only in-memory graphs.

## Central Architectural Decision

**Evidence providers do not own canonical truth. LadybugDB must own identity,
provenance, reconciliation, completeness, and the derived semantic graph.**
