# Selective SootUp JVM graph experiment

## Status and safety

SootUp 2.0.0 is available as an experimental JVM analysis provider. The production default remains
ASM with the legacy JVM graph. Selecting SootUp defaults the output to
`.gitnexus/experiments/sootup/lsp-lbug`, so an experiment cannot replace the normal
`.gitnexus/lsp-lbug` database accidentally. Existing output paths are never overwritten.

Run the experiment with the same entry point used by production indexing:

```bash
./lsp-link index /absolute/path/to/repository \
  --config config/sootup-experiment.json
```

An explicit output remains supported:

```bash
./lsp-link index /absolute/path/to/repository \
  --config config/sootup-experiment.json \
  --output /absolute/path/to/repository/.gitnexus/experiments/sootup/lsp-lbug
```

Run both semantic extractors against the resulting database:

```bash
npm run extract -- /absolute/path/to/repository/.gitnexus/experiments/sootup/lsp-lbug \
  --extractor temporal --extractor kafka
```

After producing both databases, run the strict normalized semantic-path gate:

```bash
npm run compare:semantic -- \
  /absolute/path/to/repository/.gitnexus/lsp-lbug \
  /absolute/path/to/repository/.gitnexus/experiments/sootup/lsp-lbug \
  --extractor temporal --extractor kafka
```

## Architecture

The experiment changes only the JVM analysis and JVM publication projection:

1. LSP remains authoritative for source documents, ranges, and language-server observations.
2. Bazel remains authoritative for target ownership, generated artifacts, and ordered classpaths.
3. Repository inventory records lexical source and configuration evidence.
4. `JvmProgramAnalyzer` selects either the existing ASM worker or the isolated SootUp worker.
5. SootUp reads Jimple transiently to obtain invocation facts. Jimple, CFGs, statements, and stack
   operations are never serialized.
6. The compact projection retains first-party declarations and calls, plus referenced external
   signatures and hierarchy. External method bodies are not traversed when `externalBodies` is
   `none`.
7. LadybugDB stores the compact evidence graph. Temporal and Kafka extractors interpret that
   evidence after publication.

The worker protocol carries version 1 of the provider-neutral JVM fact contract over NDJSON and is
limited to 500 facts and 1 MiB per batch. Worker output is cached
under `.gitnexus/jvm-artifacts/program-facts/<provider>/`. A cache key includes the provider and
version, artifact content hash, ordered classpath hash, selected-class policy, projection,
external-body policy, and semantic configuration hash. Files are written to a temporary path,
completed with a validation record, and atomically renamed. Warm runs validate and stream cached
facts without loading an entire artifact into Node memory.

## Compact graph

`JvmArtifactEnrichmentRun.graphSchemaVersion` and `projection` identify the active JVM schema.
Compact calls are `JvmCompactCall` relationships from `JvmMethod` to a minimal
`JvmMethodReference`; hierarchy is represented by `JvmCompactTypeReference` relationships to
`JvmTypeReference`. The compact database does not publish `JvmCallSite`, `JvmBinaryReference`, or
`JvmClassResolution` rows for SootUp facts.

Configuration evidence is framework-neutral. `ConfigurationKey`, `ConfigurationValue`,
`ConfigurationReference`, and `DeploymentUnit` preserve Spring properties/YAML, Kubernetes
environment and ConfigMap/Secret references, and Helm values/template references. Candidate
values retain status, scope, profile, precedence, confidence, source document, and location. An
unknown deployment or profile is represented as alternatives rather than resolved arbitrarily.

## Validation fixture

`sample_projects/sootup-temporal-kafka-flow` is the neutral acceptance fixture. It contains an
ingress call, workflow contract and implementation, activity contract and implementation,
Kafka producer, listener, Spring configuration, Helm override, Kubernetes binding, and Bazel
ownership.

Focused tests compare ASM and SootUp declarations and call targets, verify annotation and topic
evidence, ensure compact publication creates no legacy call-site or class-resolution rows, and
verify unchanged warm runs do not rewrite cached artifact facts. SootUp 2.0 does not enumerate
annotation declaration classes consistently; compatibility comparison records that difference,
while annotation usages on first-party types and methods remain stored and are accepted as exact
semantic-type evidence.

## Experiment boundaries

- No framework package allowlist is used by the relevance projection.
- No comprehensive Spring application topology is inferred in this slice.
- Kafka producer-to-topic argument data flow is not claimed as exact. When the argument cannot be
  resolved, the extractor emits evidence-backed topic candidates with reduced confidence.
- Virtual/interface calls retain their declared target and dispatch kind. Full bounded CHA target
  expansion remains a follow-on experiment; no unproven target is stored as exact.
- ASM/legacy remains the fallback until compact semantic-flow parity is confirmed on the target
  repository.

## Dependency packaging

The SootUp runtime is isolated from Node and pinned under `vendor/sootup/2.0.0`. The checksum lock
is `vendor/sootup/2.0.0/dependencies.lock.json`; `install.sh` verifies the closure and builds the
worker without network access. `npm run sootup:resolve` is the maintainer-only Maven resolution
step used when intentionally regenerating the approved closure.
