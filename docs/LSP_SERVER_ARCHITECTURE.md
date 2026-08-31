# LSP server architecture

`lsp_server/` owns protocol transport and language-server lifecycle. It does
not own graph projection or LadybugDB writes.

## Boundaries

```text
contracts/   shared request/response and adapter interfaces
adapters/    language-server launch, lifecycle, and capability access
registry/    language selection and independent build-root discovery
scripts/     optional server installation helpers
test/        build import and routing tests
```

`indexer/` consumes the registry and adapters, normalizes responses, records
capability coverage, performs the separate JVM artifact stage, and writes
LadybugDB.

The adapter registry supports Java, Kotlin, Python, C/C++, Rust,
TypeScript/JavaScript, C#, and COBOL. The production runner uses this same
catalog: Java follows the specialized build-root/JDT path, while other
registered languages use generic semantic partitions. JVM artifact enrichment
remains a separate stage and does not turn bytecode evidence into an LSP
observation.

## Overall production flow

The component has no competing production crawler. The root launcher owns the
workflow, while this package participates only in the semantic-crawl step:

```text
./lsp-link index REPOSITORY
  -> verify tools and configuration
  -> prepare-build-model
       discover/filter Bazel targets
       run the scoped aspect build (reusing Bazel's action cache)
       validate and write the handoff
  -> build-index
       inventory files and compute crawlCacheId
       exact cache hit: restore observations without LSP startup
       cache miss: route semantic partitions through this adapter registry
       normalize calls and enrich artifacts
       bulk-load and atomically publish the graph
```

An ordinary earlier `bazel build` is optional cache warm-up. It neither needs
to be repeated manually nor replaces `prepare-build-model`, because the normal
build does not produce the indexer-specific handoff and source inventory.

## Java build roots and process topology

The registry discovers Maven reactors, Gradle builds, nested Bazel workspaces,
and unmanaged Java roots independently. Each source file is assigned to its
nearest owning root.

The shard planner weights roots by Java source-file count and assigns them to a
bounded number of persistent JDT LS processes. Shards run concurrently. Roots
assigned to one shard are crawled sequentially, and requests within an
individual server session are currently serialized. `buildRootId` preserves
logical ownership on servers and workspace documents; `processShardId` records
which physical JDT LS process served the root.

Build-system integration differs by root type:

- Maven uses the M2E model imported by JDT LS.
- Gradle uses Buildship import.
- A source root has one project owner. If Maven and Gradle descriptors coexist
  at that exact root, Gradle owns it by default; `GITNEXUS_JDT_NATIVE_IMPORTER`
  can select Maven. M2E and Buildship are never allowed to import the same tree.
- Bazel generates an external Eclipse model from exact `JavaInfo` compile-time
  and runtime JARs.
- Maven and Gradle use an external Eclipse model when native multi-module
  import is unavailable.
- Unmanaged roots use source discovery and an external Eclipse model.
- Spring Tools may start as a companion to a JDT shard and can ask JDT for Java
  type and classpath information. The production crawler persists the companion
  as its own `LspServer` and stores its exact executable-project and structure
  responses in `observationsJson`; normalized framework projections can be
  derived later without recrawling or losing provider-specific fields.

Spring companions are root-scoped, even when JDT processes are shard-scoped.
Only roots with Spring build/classpath markers receive a companion, avoiding a
1 GB Spring process for unrelated Java roots. The adapter forwards JDT's
`workspace/executeClientCommand` classpath callbacks to Spring Tools and does
not publish the companion as ready until it reports a project or structure.

Bazel model preparation and root crawls use bounded concurrency. JDT LS
full-runtime JARs replace Bazel header JARs for navigation, while
compile/runtime/header identities remain available to artifact enrichment.

Generated shard workspaces and completed build outputs are retained for reuse
and diagnosis; the indexer does not perform implicit workspace cleanup.
Eclipse/Equinox may also create runtime state under a JDT LS configuration
directory. That state is generated content and should not be committed as a
source change.

## Startup and protocol sequence

JDT LS reports service readiness before Maven, Gradle, or external Eclipse
projects are necessarily imported. A shard therefore waits for project import,
then verifies that every Bazel-provided dependency is present in JDT's effective
classpath or module path before source crawling begins. The set comparison is
cheap and normally runs once. Incomplete but improving responses retry with
bounded backoff; stable mismatches and repeated command failures fail quickly
with concrete diagnostics instead of consuming the full startup deadline.

One startup deadline covers every readiness phase rather than restarting a
fresh timeout at each boundary. A size-derived budget ranges from three to
fifteen minutes unless `GITNEXUS_JDT_STARTUP_TIMEOUT_MS` overrides it. Phase
transitions and periodic heartbeats expose the process ID, heap, Node/JDT RSS,
file/classpath counts, and pending roots. Bounded stderr and exit state are
attached to startup failures.

```text
initialize -> initialized -> wait for project import
  -> declaration inventory: documentSymbol once per document
  -> declaration-scoped references and eligible hierarchy/call requests
  -> semantic tokens once per document
  -> navigation/hover only for token positions not already covered by
     declaration-reference evidence
  -> signature help and diagnostics at eligible document positions
  -> persist root checkpoint
  -> next root on the shard
  -> shutdown -> exit
```

This is one facts-first crawl algorithm. `core` and `exhaustive` select coverage
depth, not competing crawlers. The declaration inventory establishes the
workspace symbol registry before cross-document results are mapped. Repeated
read-only requests with identical method and parameters are coalesced and
memoized within the server session.

Negotiated capabilities determine which requests are eligible. Unsupported,
excluded, failed, timed-out, empty, mapped, and unmapped outcomes remain
distinct coverage facts rather than silently collapsing to an empty response.
Locations outside the repository are represented as external documents or
symbols and remain separate from owned source documents.

One provider compatibility rule is intentionally explicit: JDT LS may return
a JSON-RPC envelope with neither `result` nor `error` for type-definition
requests on Java primitives and synthetic array `length`. Since the LSP result
is nullable and no declaration exists for these constructs, the JDT adapter
normalizes that exact response to `null`. Other malformed responses still fail.

Use `npm run query` for direct interactive requests. Use
`./lsp-link index /path/to/repository` for every production repository crawl.

## Persistence and restart behavior

The crawler writes a checkpoint only after a complete build-root crawl. It
also checkpoints call normalization and JVM artifact enrichment as separate
stages. Fingerprints include source/build inputs and crawl configuration, so an
incompatible checkpoint is ignored instead of hiding a changed observation.

Root-level checkpoints avoid repeating completed roots in a multi-root
repository. They do not preserve progress within one root: interrupting a long
single-root crawl repeats that root on the next run. A repository-wide
content-addressed crawl identity can restore a compatible completed crawl
without starting a language server. Graph publication bulk-loads staged CSV
data and atomically publishes only after required stages succeed.

## Performance characteristics

The dominant cost is protocol request count, not filesystem discovery. For a
root with `D` documents, `S` discovered declarations, `R` declaration-scoped
reference requests, `G` uncovered semantic-token positions, and `H`
signature-help positions, the crawl performs:

- one document-symbol request per document;
- one reference request per eligible declaration, plus hierarchy and call
  requests for eligible symbol kinds and the chosen coverage profile;
- definition, declaration, hover, and eligible type/implementation requests
  only for semantic-token positions not covered by mapped reference evidence;
- one full semantic-token request and diagnostic requests per document; and
- one signature-help request per heuristically discovered call position.

The practical cost is therefore closer to `O(D + R + G * gap-capabilities +
H)` than the former Cartesian `O(D + S * capabilities + T * capabilities)`
shape. Large implementation/reference responses
may also enumerate standard-library or dependency locations, increasing
normalization and graph-materialization work. Increasing root concurrency does
not shorten a repository that contains only one large build root.

## Efficiency roadmap

Efficiency changes must preserve the complete evidence graph and its coverage
semantics. Every eligible capability, request position, result range, external
node, and provider observation remains part of the raw LSP model. Optimization
must not replace distinct observations with one canonical fact or omit nodes
because a framework-specific consumer does not currently use them.

Canonical identities and normalized calls belong in separate derived tables.
They may point back to raw observations, but they never replace or delete the
underlying `Lsp*` nodes and relations. A skipped, failed, budgeted, or truncated
request must remain explicit and must never be reported as an authoritative
empty result.

### 1. Measure before changing scheduling

Add per-capability request counts, elapsed-time histograms, result sizes, queue
wait, project-import time, and per-document progress. Report the slowest
capabilities and roots at the end of a run. Establish cold and warm baselines on
the Maven sample, a dependency-heavy project, and the multi-root fixture.

This is the prerequisite for every optimization below: wall-clock improvement
must be attributable to cached equivalent work, lower latency, better overlap,
faster import, or less persistence overhead rather than reduced graph content.

### 2. Avoid duplicate execution without reducing observations

Some logical requests may have identical `(server configuration, document
content, method, parameters)` inputs even though multiple crawl paths depend on
their evidence. Execute an identical protocol request once, cache its raw
response, and replay normalization for every requesting context so all expected
coverage counters, provenance, ranges, nodes, and relations are still emitted.

Cache keys must include the JDT LS version, JDK, build-model fingerprint,
workspace/project identity, document content hash, capability, parameters, and
relevant initialization settings. Failed and timed-out requests require a
short-lived or run-local policy so a transient failure is not promoted into a
persistent result.

This optimization does not infer that two different positions, capabilities,
providers, or request contexts are semantically interchangeable. External
results remain fully materialized. If two observations normalize to the same
canonical identity, both raw observations remain connected to that separate
derived identity.

### 3. Add resumable units inside a root

Persist deterministic pass/document batches and their fingerprints so an
interrupted single-root crawl can resume after the last completed unit. Keep
symbol-discovery completion as a barrier before cross-document mapping. Merge
resumed batches by stable identifiers and retain per-capability attempted,
failed, and timeout counts.

This improves recovery time rather than a successful cold run, but it prevents
long Maven or monorepo crawls from repeatedly losing all in-root work.

### 4. Introduce bounded in-session concurrency

Allow a small configurable window of independent read requests within one
initialized JDT LS session. Start with capability groups that do not mutate
document state and keep `didOpen`, `didClose`, project import, and shutdown
ordered. Use separate per-method limits for expensive implementation/reference
requests and apply backpressure to large responses.

Results must be merged deterministically using stable IDs and explicit
ordinals. Validate that concurrency does not change result sets, diagnostics,
coverage counters, or JDT LS stability before raising the default above one.

### 5. Improve scheduling and persistence

- Use native Maven/Gradle project URIs after successful M2E/Buildship import;
  reserve copied external projects and URI remapping for Bazel and genuine
  fallback roots. This avoids duplicate source indexing without changing the
  requested source set.
- Reuse compatible imported JDT workspaces by a complete build-configuration
  fingerprint instead of deleting every JDT data directory before startup.
- Continue validating and reusing the inventory-hash source snapshots now
  exposed to generated projects through Eclipse linked resources; retain
  copied staging only as a compatibility fallback.
- Weight shards with measured symbol/request cost instead of source-file count
  alone.
- Use a work queue so a shard that finishes a cheap root can accept remaining
  work where project isolation permits it.
- Stream bounded observation batches into transactional persistence instead of
  retaining the complete repository graph in memory.
- Batch LadybugDB inserts and deduplication by stable-key partitions.
- Keep persistent ASM worker concurrency independent from LSP request
  concurrency so artifact parsing cannot starve language servers.

### 6. Correctness gates

Each optimization should be accepted only when fixture comparisons show:

- identical raw node and relation multisets, including owned and external
  documents, symbols, occurrences, call sites, hovers, tokens, diagnostics,
  signatures, ranges, and provenance;
- identical eligible, attempted, successful, empty, failed, timed-out, mapped,
  external, and unmapped coverage counters;
- identical call, definition, declaration, reference, implementation, type,
  hierarchy, hover, token, signature, and diagnostic observations;
- no unsupported, failed, timed-out, excluded, or truncated outcome converted
  into `empty`;
- deterministic graph IDs and relation ordering regardless of request
  completion order; and
- lower request count, wall time, or peak memory on at least one representative
  benchmark without reducing graph content.
