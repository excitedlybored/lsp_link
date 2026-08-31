# Layered Bazel Java monorepo — 5,000 documents

This deterministic synthetic fixture models a large three-layer Java monorepo
without containing organization-specific code, labels, dependencies, or names.
It is intended to exercise Bazel scope resolution, the recursive source aspect,
source-inventory scaling, JDT.LS crawling, artifact enrichment, and prebuilt
handoff validation.

The generated `workspace/` contains exactly 5,000 Java documents in 500
component packages:

| Layer or category | Packages | Java documents and behavior |
| --- | ---: | --- |
| Central dependency bundles and compiler plugin | 2 | 20 shared platform documents |
| Production libraries | 250 | Chained reusable Java libraries |
| Temporal workflows | 60 | Contracts, activities, implementations, workers, compensation, and tests |
| Application services | 150 | Java libraries, Temporal workflow launchers, executables, and tests |
| QA simulators | 40 | Simulator libraries, executable launchers, and tests |

Every component declares a production `java_library` and relevant `java_test`.
Services and simulators also declare a `java_binary`. Direct dependencies form
one deterministic chain across the decentralized component layer, while every
component consumes one centralized dependency bundle and the shared annotation
processor.

Every workflow package follows the standard Temporal Java shape: an annotated
workflow contract with workflow, signal, query, and update methods; an
annotated activity contract; deterministic orchestration state; an activity
implementation; worker registration; and an explicit compensation path.
The workflow implementation also exercises bounded retry loops, pause/resume
coordination, cancellation checks, child workflow creation, multi-step state
transitions, audit recording, payment authorization, completion notification,
and reverse-order compensation. Activity implementations use longer internal
helper chains for validation, normalization, risk scoring, identifier creation,
notification formatting, audit persistence, reversals, and releases. These
paths deliberately create a dense, deterministic bytecode call graph for
validating method-call tracking without adding more documents.
Application services create typed workflow stubs and start executions. QA
simulators drive update, cancellation-signal, and query paths against the same
contracts. The fixture includes a small source-compatible Temporal API surface
under the platform bundle so the sample remains hermetic and does not require
an external artifact repository; the application code uses the canonical
`io.temporal.*` identities consumed by the Temporal semantic extractor.

Each package also declares representative targets named `*_deploy_bannedcheck`,
`*-sonar`, and `*-sq`, plus coverage/reporting-only targets. The supplied
configuration excludes them before configured analysis. A deployment
`filegroup` remains visible to unconfigured discovery but is outside the Java
rule-kind allowlist.

## Generate the workspace

From the repository root:

```bash
node sample_projects/bazel-layered-java-monorepo-5000/generate.mjs
```

Generation is reproducible. The ignored `workspace/` directory can be safely
regenerated because it carries a synthetic-fixture marker. To generate into a
different empty directory, use `--output /absolute/path`. The generator refuses
to replace any nonempty directory that does not carry its own marker.
It initializes a nested local Git index and stages the generated files without
creating a commit. This mirrors a real checkout and lets source-inventory
deduplication recognize checked-in sources and their source-JAR counterparts as
the same 5,000 logical documents.

The generator prints the verified Java-file, BUILD-file, package, and category
counts. The committed `sample-size.json` inside the generated workspace records
the intended scale independently of the generation marker.

## Build with Bazelisk

The fixture pins the validated Bazel 7.6.1 release in `.bazelversion`, declares
`rules_java` through Bzlmod, and uses Java 21 language/tool settings.

```bash
cd sample_projects/bazel-layered-java-monorepo-5000/workspace
bazelisk build //...
cd ../../../
```

The ordinary build warms Bazel's action cache. Indexer preparation still runs
its own successful recursive aspect build; it should reuse those compiled
actions.

## Prepare and index the sample

From the repository root, run these exact commands:

```bash
npm run index -- bazel-prepare \
  sample_projects/bazel-layered-java-monorepo-5000/workspace \
  --config sample_projects/bazel-layered-java-monorepo-5000/index-config.json

npm run index -- build \
  sample_projects/bazel-layered-java-monorepo-5000/workspace \
  --config sample_projects/bazel-layered-java-monorepo-5000/index-config.json \
  --output /tmp/layered-java-5000.lbug
```

The sample config uses prebuilt indexing, a one-hour total preparation budget,
four-way bounded concurrency, resumable facts-first crawling, unlimited class
enrichment, source fetching, and strict build-root failure enforcement.
It deliberately uses the scalable `core` crawl profile. The Temporal extractor
can identify the standard workflow annotations, implementations, and SDK calls
from the JVM graph produced by this profile. Use `exhaustive` only when precise
source ranges, hover bindings, and LSP call-hierarchy observations are also
required across all 5,000 documents.
