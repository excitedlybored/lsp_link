# Complete-Crawl Performance Plan

The solution is to preserve complete coverage without treating every LSP
capability as valid at every source position.

## 1. Replace the Cartesian crawl with a facts-first crawl

Use each capability only on its natural domain:

1. Request `documentSymbol` once per document.
2. Request semantic tokens once per document.
3. Request references once per declared symbol.
4. Request call hierarchy only for methods, functions, and constructors.
5. Request type hierarchy only for classes, interfaces, and enums.
6. Request implementation only for implementable declarations.
7. Request hover only for declarations and unresolved external references.
8. Request signature help only at detected call-expression positions.

References requested from a known declaration already identify all returned
locations as occurrences of that declaration. There is no need to query
definition, declaration, and hover again at each of those token positions.

Afterward, query token positions only when they remain unresolved, primarily
for external library references. This keeps the crawl complete while
eliminating most duplicate requests.

## 2. Add bounded request concurrency inside each JDT.LS process

`--concurrency` currently controls the number of JDT.LS shards, not requests
within one server.

Introduce two queues:

- Lifecycle queue: `didOpen`, `didClose`, and workspace changes; concurrency 1.
- Read-only request queue: hover, definition, references, and hierarchy;
  concurrency initially 4.

Process documents independently while keeping each document open until all its
requests finish. Make read concurrency configurable:

```bash
--lsp-request-concurrency 4
```

A single Maven root can then use four concurrent requests instead of one.

## 3. Index symbol lookup structures

Current mapping repeatedly filters all symbols:

```javascript
symbols.filter(symbol => symbol.uri === uri)
```

Replace it with indexed structures:

```text
symbolsByUri
exactSymbolByUriAndRange
symbolsByUriIntervalIndex
semanticTokensByDocument
occurrencesByDocumentAndPosition
```

This changes repeated mapping from linear scans to near-constant or logarithmic
lookup.

## 4. Persist each stage directly to LadybugDB

The current pipeline holds large batches in memory and writes the database only
at the end. Change it to:

```text
LSP crawl
  -> write LSP schema and rows
  -> commit stage
  -> usable .lbug

Call normalization
  -> append derived schema and rows
  -> commit stage

Artifact enrichment
  -> append JVM schema and rows incrementally
  -> commit batches
```

Record each stage as `running`, `complete`, `partial`, or `failed`. An
interrupted artifact crawl should leave a valid LSP graph that can be resumed.

## 5. Stop duplicating large checkpoints

The root checkpoint and aggregate LSP checkpoint currently serialize
essentially the same graph twice. A 41-file Spring Boot project produced two
203 MB copies.

Keep:

- one checkpoint per build root;
- a small manifest listing completed roots and fingerprints;
- incremental LadybugDB rows as the durable result.

The aggregate checkpoint should reference root checkpoints instead of embedding
their contents.

## 6. Replace repeated `javap` processes — implementation complete

The artifact stage now launches one JDK 21-compatible worker using vendored
ASM Core 9.9.1. It parses JARs without classloading and streams versioned,
bounded NDJSON batches into per-artifact disk spools. Completed spools are
converted to bounded CSV fragments and loaded into the staging LadybugDB with
`COPY FROM`; small run/status updates remain transactional. Failed worker
attempts truncate back to their spool checkpoint before the one-time replay,
and resume restores run totals from validated completed-artifact sidecars.

The implemented flow is:

```text
Node orchestrator
  -> persistent JVM worker
  -> open each JAR once
  -> parse class, method, field, annotation, and bytecode data
  -> stream normalized NDJSON batches
  -> LadybugDB
```

This remains framework-neutral. Temporal, Spring, Kafka, and MongoDB are simply
bytecode and annotation data.

`--artifact-concurrency` now controls worker parsing threads (4 by default,
bounded to 16). Artifact hashes, classpath ordinals, completion state, and
canonical duplicate-class resolution are persisted. The old `javap` parser,
queue, executable lookup, and fallback path have been removed.

The deterministic correctness and interruption/resume parity runs pass. The accepted combined
Node/worker/Ladybug RSS scaling gate requires the 100,000-class peak to remain
strictly below 3× the 25,000-class peak. With the deterministic 1 GiB LadybugDB
pool, the latest gate peaked at 1,318,809,600 bytes for 25,000 synthetic
classes and 2,646,167,552 bytes for 100,000 classes, a 2.006× ratio. Throughput
was 1,341 and 785 classes/second respectively. This improves the former
100,000-class result of 4,207,955,968 bytes at roughly 414 classes/second while
preserving graph parity, duplicate-class resolution, atomic publication, and
resumable completed artifacts.

## 7. Make the vendored JDT.LS runtime immutable

Copy only the selected JDT configuration into the shard's temporary workspace:

```text
vendor/jdtls/1.57.0/config_mac_arm
  -> /tmp/lsp-link/<shard>/configuration
```

Launch JDT.LS against the private copy. Never allow Equinox to update tracked
vendor files.

## 8. Repair Spring Tools packaging

The Spring extension currently references two missing bundles:

- `commons-lsp-extensions.jar`
- `xml-ls-extension.jar`

The installer should validate every configured Spring extension JAR before
starting JDT.LS. Missing optional bundles should be omitted from initialization;
required bundles should fail with a precise installation error.

## Recommended implementation order

1. Private JDT configuration and Spring bundle validation.
2. Incremental `.lbug` stage writes.
3. Facts-first request planner.
4. Request concurrency of four.
5. Indexed symbol and occurrence lookup.
6. Non-duplicating checkpoints.
7. Persistent JVM bytecode worker.

The biggest immediate speedup will come from removing redundant semantic-token
position queries. Concurrency alone would only execute the current excessive
workload faster.
