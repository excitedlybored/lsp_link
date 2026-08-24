# Isolated LSP Knowledge Graph

This package defines an LSP-native knowledge graph and LadybugDB schema. It is
additive and does not write to or change GitNexus's existing `.gitnexus/lbug`
database.

## Boundary

```text
Language servers
  -> protocol observations
  -> .gitnexus/lsp-lbug       (this package)
  -> reconciliation/projection
  -> .gitnexus/lbug           (existing GitNexus model, later integration)
```

The native graph stores protocol facts without prematurely mapping every LSP
symbol into a GitNexus `Class`, `Method`, or `CodeElement` table.

## Node classes

| Table | Role |
| --- | --- |
| `LspAnalysisRun` | Workspace, protocol, position encoding, outcome, and run counters |
| `LspServer` | Server identity, language, negotiated capabilities, and status |
| `LspDocument` | Workspace or external URI and content identity |
| `Lsp*Symbol` (26 tables) | One physical node class per standard `SymbolKind`, each with full and selection ranges |
| `LspCallSite` | One precise caller-relative range from call hierarchy `fromRanges` |
| `LspOccurrence` | Definition, declaration, reference, implementation, or type-hierarchy location |
| `LspDiagnostic` | Compiler/language-server diagnostics with exact ranges |
| `LspCoverage` | Query outcome and mapping counts by capability/document/language |
| `LspHover` | Request position, optional result range, content format, and content |
| `LspSemanticToken` | Decoded absolute token position, type, length, and modifiers |
| `LspSignatureHelp` | Request position and active signature/parameter selection |
| `LspSignature` | One structured signature alternative returned by signature help |
| `LspParameter` | Parameter label or offsets, documentation, and ordinal |

## Direct symbol classes

All 26 standard LSP `SymbolKind` values have exact discriminated TypeScript
classes and exact physical LadybugDB node classes. Examples include
`LspPackageSymbol`, `LspFieldSymbol`, `LspEnumMemberSymbol`, `LspEventSymbol`,
and `LspTypeParameterSymbol`; none are folded into `CodeElement`, a generic
`LspSymbol` table, or another approximate class.

`toSymbolRecord()` validates `(kind, kindName)` and selects the concrete table
before persistence, so a `Field` cannot silently be written as a `Property`.
Ladybug's relationship group is correspondingly expanded over all legal
concrete endpoint pairs. This is intentionally more DDL: direct database class
identity takes precedence over schema compactness.

All positions remain zero-based LSP positions. `LspAnalysisRun.positionEncoding`
records the negotiated unit (`utf-8`, `utf-16`, or `utf-32`). Projection code is
responsible for converting them to another coordinate convention.

## Relationship policy

`LspRelation` preserves the analysis run, server, capability, observation
status, provider authority, and identity-mapping confidence separately.
Provider observations are not destructively replaced when they disagree.

`CALLS`, `IMPLEMENTS`, and other GitNexus relationships are derived projections;
they are not raw LSP facts. A call is represented natively as:

```text
LspMethodSymbol -[HAS_CALLSITE]-> LspCallSite -[RESOLVES_TO]-> LspFunctionSymbol
```

Every `fromRanges` entry becomes a distinct `LspCallSite`; repeated calls from
one caller to the same callee therefore remain independently queryable.

## Capability compatibility

| LSP capability | Native representation |
| --- | --- |
| Hierarchical document symbols | `LspDocument -[DEFINES]-> Lsp*Symbol -[CONTAINS]-> Lsp*Symbol` |
| Incoming/outgoing call hierarchy | `LspCallSite` per `fromRanges` entry, with direction and capability |
| Implementations | Polymorphic `IMPLEMENTATION_OF` between exact symbol classes |
| Type hierarchy | Neutral `TYPE_HIERARCHY_SUPERTYPE`; no invented extends/implements semantics |
| Definition/declaration/reference | `LspOccurrence` with full target, selection, and origin ranges |
| Hover | `LspHover`, optionally linked to a mapped symbol |
| Diagnostics | `LspDiagnostic` with provider, status, range, severity, code, and tags |
| Semantic tokens | Decoded `LspSemanticToken`, optionally linked to a mapped symbol |
| Signature help | `LspSignatureHelp -> LspSignature -> LspParameter` |

`LspRelation` stores the observation id, run, server, source capability,
mapping status, provider authority, mapping confidence, raw/derived flag,
reason, and ordinal. Multiple provider observations may coexist; disagreement
is represented rather than destructively resolved.

Relation kinds have explicit legal endpoint classes. For example,
`HAS_CALLSITE` only permits a concrete `Lsp*Symbol -> LspCallSite`, while
`IMPLEMENTATION_OF` permits concrete symbol-class pairs. A physically valid but
semantically invalid pair is rejected before persistence.

The current schema contains 38 node tables (26 symbol classes plus 12 protocol
observation/support classes) and one relationship table.

## Ingestion and persistence

`ingestDocumentSymbols`, `ingestCalls`, and `ingestOccurrence` convert raw
protocol observations into native nodes and endpoint-checked relationships.
`collectCapabilities` executes capability work while preserving the difference
between unsupported, excluded, failed, timed-out, empty, observed, mapped, and
unmapped results in `LspCoverage`.

`LspLadybugRepository` creates the isolated schema and writes an observation
batch in a transaction. Symbols are routed through `toSymbolRecord()` before
insertion, and relations are written only after their concrete endpoint nodes.
`openLspLadybugDatabase()` accepts the installed `@ladybugdb/core` module and a
path such as `.gitnexus/lsp-lbug`; it never opens or modifies `.gitnexus/lbug`.

The standalone adapter now exposes its negotiated server capabilities, raw
request access, canonical document URIs, and buffered notifications. Adapter
orchestration should construct capability tasks from these primitives instead
of treating a swallowed request error as an empty response.

## Development

```bash
npm run build
npm test
```
