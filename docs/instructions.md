# Indexer instructions and run-configuration reference

Run commands from the repository root. Paths shown below are examples; replace
the workspace and output paths with locations on your machine.

## Run it

From the `lsp_link` repository root:

```bash
./lsp-link index /absolute/path/to/repository
```

Add `--background` to detach it from the terminal. The log and PID are written
to `.gitnexus/index.log` and `.gitnexus/index.pid` in the target repository.
The launcher installs missing local tools, loads `config/default.json`, runs
`prepare-build-model`, and starts `build-index` only after preparation succeeds.
The default graph is `<repository>/.gitnexus/lsp-lbug`.

## Overall automated flow

`./lsp-link index` is the only public workflow. It orchestrates these stages in
order and stops before publication if a required stage fails:

```text
index REPOSITORY
  |
  +-- launcher setup
  |     verify/install bundled tools
  |     load and validate config/default.json (or --config)
  |
  +-- prepare-build-model
  |     discover Bazel build roots; skip when none exist
  |     query each configured scope and exclude non-index targets
  |     run the scoped Bazel aspect build
  |     validate classpaths, sources, artifacts, and configuration identity
  |     publish the indexer-specific handoff
  |
  +-- build-index
        inventory repository and structural documents
        compute the content-addressed crawl-cache ID
        exact cache hit -> load completed semantic observations
        cache miss      -> start adapters and perform the LSP crawl
        normalize calls and stream JVM artifact enrichment
        generate CSV and bulk-copy graph nodes/relationships
        atomically publish <repository>/.gitnexus/lsp-lbug
```

An earlier `bazel build` is detected indirectly through Bazel's normal action
cache: compatible compilation actions are reused by the scoped aspect build.
No separate build command or flag is needed. The ordinary build cannot replace
`prepare-build-model`, because it does not emit the indexer handoff, source
inventory, configured graph, or artifact associations. An unchanged rerun can
then reuse both Bazel actions and the exact LSP crawl cache.

The tracked default uses `prepared`, so preparation is visible as a separate
logged process before `build-index`. If an advanced configuration selects
`integrated`, `build-index` executes the same build-model preparation internally;
the public command and resulting evidence flow remain unchanged.

Code-bearing database nodes include `codeOrigin`, which separates editable
repository code, generated first-party source, first-party compiled artifacts,
third-party dependencies, standard-library code, and unclassified evidence.
See [Code-origin classification](code-origin.md) for definitions, persistence
coverage, filtering guidance, and query examples.

Preparation prints a start and completion line for target discovery, tag
filtering, execution-root lookup, and the recursive JVM/`JavaInfo` aspect build. A Bazel
stage that runs longer than 15 seconds emits a heartbeat with elapsed time,
captured output size, and Bazel's latest status line. A quiet interval between
heartbeats is therefore expected and does not indicate a hang.

During indexing, each LSP pass reports `completed/total`, percentage, and its
current documents-per-second rate. The `core` profile performs one bounded
`document-symbols` pass. The `exhaustive` profile additionally reports the
symbol-reference and document-fact passes. Repeated capability timeouts open a
per-capability circuit breaker; the run continues and the timeout/partial
coverage remains explicit in the graph.

JDT startup uses one deadline across launch, initialize, service readiness,
Eclipse project import, and classpath validation. It emits `[jdtls-startup]`
phase records and 15-second heartbeats containing elapsed/remaining time,
source files, classpath entries, pending roots, the 2/4/6 GiB heap selection,
PID, Node RSS, and JDT RSS when available. The automatic deadline scales from
three to fifteen minutes; set `GITNEXUS_JDT_STARTUP_TIMEOUT_MS` for a fixed
positive millisecond value and `GITNEXUS_JDT_STARTUP_HEARTBEAT_MS` to change
the reporting interval. The older
`GITNEXUS_JDT_CLASSPATH_READY_TIMEOUT_MS` remains a compatibility alias.
Failures include process exit state and only a bounded stderr tail.
The `classpathReadiness` heartbeat object shows attempts, completed roots,
classpath/module-path entries returned by JDT, matched/missing expected entries,
and `stalledForMs`. A stable missing count indicates a classpath-model mismatch;
a decreasing count indicates continuing import progress.

Classpath readiness is a strict correctness gate, not a second dependency
scan. It succeeds after one complete response, retries incomplete responses
with backoff only for a short bounded window, and reports missing path samples
or repeated command errors on failure. The defaults are a 30-second stable
coverage limit and three consecutive request errors; override them with
`GITNEXUS_JDT_CLASSPATH_STALL_TIMEOUT_MS` and
`GITNEXUS_JDT_CLASSPATH_MAX_ERRORS` when necessary.

Source mapping and temporary Eclipse-project construction occur before the JDT
process exists. `[jdtls-workspace]` records report mapping, cache validation or
building, consolidation, and project-linking progress every 250 files during
this synchronous preparation window. Consolidated sources are cached by the
semantic source-inventory hash, validated from an atomic completion manifest,
and exposed through Eclipse linked folders. An unchanged warm run performs no
Java source copies. `GITNEXUS_JDT_SOURCE_LAYOUT=copied` selects the physical-copy
fallback; those copies use filesystem copy-on-write cloning when supported.

`bash install.sh` also verifies and installs the vendored Spring Tools runtime
offline under `.gitnexus/tools/spring-tools`. Spring-capable roots therefore do
not depend on editor extensions or network access. Set
`GITNEXUS_SPRING_TOOLS=false` only when intentionally disabling that protocol.

The aspect build writes a per-run Build Event Protocol (BEP) JSON stream. After
the build, `bazel:aspect-output-discovery` follows the output group's shared
`NamedSetOfFiles` references and reads only manifests reported by that build.
It does not recursively scan `bazel-out`, and stale manifests from prior builds
cannot enter the graph. The BEP file is removed after successful processing and
also removed after controlled failures so workspace labels and paths are not
left behind in an additional diagnostic trace.

## Install

Requirements:

- Node.js `^20.17.0` or `>=22.9.0`
- npm `>=9.2.0`
- JDK 21 or newer for the bundled Java tooling
- `uv` and Python 3.12 for the analyzer and extractors
- `bazelisk` or `bazel` on `PATH` for Bazel preparation

```bash
./install.sh
```

Installation uses the checked-in packages under `vendor/npm` and verifies the
bundled Eclipse JDT.LS runtime. Set `GITNEXUS_JDT_JAVA_HOME` if the required JDK
is not in a conventional location.

The installer also verifies that the vendored LadybugDB native addon loads. On
macOS, if loading fails specifically because OpenSSL 3 is outside the addon's
embedded Homebrew search paths, the installer resolves `brew --prefix openssl@3`,
adds that library directory as an RPATH to the installed local
addon, applies an ad-hoc signature, and verifies loading again. It does not
modify the vendored tarball or patch unrelated loader failures. If Homebrew is
not discoverable, set `GITNEXUS_OPENSSL3_LIB` to the directory containing both
`libssl.3.dylib` and `libcrypto.3.dylib`, then rerun `./install.sh`. The repair
requires the standard macOS `otool`, `install_name_tool`, and `codesign`
utilities.

## Bazel preparation and reuse

In this project, `prepared` means **prepared for the indexer with a successful
`prepare-build-model` run**. It does not mean that an ordinary enterprise
`bazel build` is sufficient by itself. An existing successful enterprise build
is still valuable because Bazel can reuse its action cache during preparation.

The automated sequence is always:

```text
optional earlier Bazel build (action-cache warm-up only)
    -> ./lsp-link index
         -> prepare-build-model (required indexer handoff)
         -> build-index with prepared mode (no later Bazel commands)
         -> .gitnexus/lsp-lbug
```

The tracked polyglot configuration is `config/default.json`. Its Bazel scope
selects standard Java and Kotlin/JVM libraries, applications, and tests across
the workspace. This naturally retains production, QA/simulator, and relevant
test code while filtering validation and reporting targets by generic
target-name patterns and tags before configured Bazel analysis.

The public launcher owns both phases and their ordering:

```bash
./lsp-link index /path/to/repository --background
```

The internal `prepare-build-model` and `build-index` commands remain available
for diagnostics and controlled recovery.

Run `prepare-build-model` again after changing the semantic configuration, selected
targets, BUILD files, source inputs, generated sources, or relevant Bazel
outputs. Cleaning or relocating the workspace/output cache also invalidates the
handoff. A normal `bazel build` can warm Bazel's cache, but it does not replace
`prepare-build-model`, which generates the target/source inventory required here.

The name `prepared` describes the second command only. `prepare-build-model` still
runs unconfigured scope queries and the recursive aspect build needed to create
indexer-specific metadata. A configured run does not perform a separate large
`cquery`: the successful aspect build is authoritative for the Java graph and
artifacts. Once preparation succeeds, `build-index` in prepared mode performs no
`query`, `cquery`, or `bazel build` operation.

Preparation does not use Bazel's `--keep_going` mode. The complete retained
scope must finish configured analysis and the aspect build successfully before
a new handoff is written. Starting a new preparation invalidates the previous
handoff, so a failed attempt cannot be followed by prepared indexing of stale
artifacts from an older successful run.

The default policy uses `prepared` indexing, the `core` crawl profile, the
canonical efficient crawler,
resumable checkpoints, four-way preparation/crawl/artifact concurrency, source
JAR fetching, and strict failed-root enforcement. It has no artifact-class
limit and uses the output-derived checkpoint directory unless overridden.

## JSON configuration format

Only JSON is supported. Comments and trailing commas are invalid. Unknown keys,
unsupported schema versions, malformed regular expressions, invalid enum
values, and out-of-range numbers are rejected. Paths in the configuration are
resolved relative to the directory containing the JSON file.

This is the generic shape of a complete version-1 configuration:

```json
{
  "schemaVersion": 1,
  "name": "default-index",
  "bazel": {
    "buildModelMode": "prepared",
    "scope": {
      "includeTargetPatterns": ["//..."],
      "includeRuleKinds": [
        "java_binary",
        "java_library",
        "java_test",
        "kt_jvm_binary",
        "kt_jvm_library",
        "kt_jvm_test"
      ],
      "explicitTargets": [],
      "excludeTargetNamePatterns": [
        ".*_deploy_bannedcheck$",
        ".*-sonar$",
        ".*-sq$"
      ],
      "excludeLabels": [],
      "excludeTags": ["coverage", "reporting-only"]
    },
    "preparation": {
      "concurrency": 4,
      "timeoutMs": 600000
    }
  },
  "crawl": {
    "profile": "core",
    "concurrency": 4,
    "resume": true
  },
  "artifacts": {
    "concurrency": 4,
    "maxClasses": null,
    "fetchSources": true,
    "classpathManifests": []
  },
  "quality": {
    "failOnFailedBuildRoot": true
  },
  "checkpoints": {
    "directory": null
  }
}
```

### Top-level fields

| Field | Required | Values and behavior |
| --- | --- | --- |
| `schemaVersion` | Yes | Must be the integer `1`. No other version is supported. |
| `name` | No | Any non-empty string. Defaults to `"default"`. It identifies the policy and participates in its semantic hash. |
| `bazel` | Yes | Bazel build mode, target scope, and preparation controls. |
| `crawl` | No | LSP crawl planning and execution controls. Defaults are described below. |
| `artifacts` | No | JVM artifact parsing and source-retrieval controls. |
| `quality` | No | Publication behavior when a build root fails. |
| `checkpoints` | No | Checkpoint storage policy. |

### `bazel`

| Field | Required | Values and behavior |
| --- | --- | --- |
| `buildModelMode` | No | `"integrated"` or `"prepared"`; default `"integrated"`. `integrated` lets `build-index` prepare Bazel internally. `prepared` makes `build-index` consume the validated handoff produced by `prepare-build-model`. |
| `scope` | Yes | Structured discovery and exclusion policy described below. |
| `preparation` | No | Concurrency and timeout used while preparing Bazel roots. |

`bazel.preparation` fields:

| Field | Required | Values and behavior |
| --- | --- | --- |
| `concurrency` | No | Positive integer; default `4`. Maximum number of Bazel roots prepared concurrently. |
| `timeoutMs` | No | Positive integer in milliseconds; default `600000` (10 minutes). This is the total preparation deadline and bounds commands by the remaining time. |

### `bazel.scope`

Discovery first runs unconfigured `bazel query --output=label_kind`. Rule-kind,
exact-label, target-name, and tag filtering happens before the deterministic
root list is passed to the recursive build aspect. The final labels are sorted
and deduplicated. An empty resolved scope is an error.

| Field | Required | Values and behavior |
| --- | --- | --- |
| `includeTargetPatterns` | Yes | Array of Bazel target patterns, for example `["//..."]` or `["//app/...", "//qa/..."]`. May be empty only when `explicitTargets` is non-empty. Each pattern is queried independently. |
| `includeRuleKinds` | Yes | Array of exact Bazel rule-kind names. The default policy includes standard Java and Kotlin/JVM library, binary, and test rules. Custom/Starlark kinds can be listed when their names are stable. May be empty when all desired roots are explicit. |
| `explicitTargets` | No | Array of exact Bazel labels; default `[]`. Explicit targets bypass the rule-kind allowlist, but they must resolve to rules and remain subject to target-name and exact-label exclusions. Tag exclusions discovered through an include pattern also apply. An explicitly included label cannot also appear in `excludeLabels`. Use this for a custom Java-producing target that has a nonstandard rule kind. |
| `excludeTargetNamePatterns` | No | Array of JavaScript regular-expression strings matched against only the target-name portion of each label; default `[]`. Invalid regexes are rejected while loading the config. Anchor patterns with `^` or `$` when exact positioning matters. |
| `excludeLabels` | No | Array of exact Bazel labels; default `[]`. Use for known coverage, reporting, validation, or other roots that should never enter configured analysis. |
| `excludeTags` | No | Array of literal Bazel tag values; default `[]`. For every include pattern, a separate unconfigured tag query identifies matching rules for exclusion. |

At least one of `includeTargetPatterns` or `explicitTargets` must be non-empty.
Exclusions are recorded with reasons as provenance, but excluded targets do not
become configured-target evidence nodes. Dependencies of selected roots are
still captured through Bazel `JavaInfo`; the scope controls top-level roots, not
manual pruning of their required classpaths.

The build aspect recursively traverses `deps`, `exports`, `runtime_deps`, and
`plugins`. For each Java target it records the label, direct sources, direct
dependency labels, direct compile JARs, runtime output JARs, and source JARs.
An aspect output group causes those artifacts to be materialized by the same
successful `bazel build`. The indexer reconstructs the complete classpath from
the recursive direct records, avoiding repeated transitive classpaths. For
backward-compatible runs without `--config`, one combined `cquery` collects all
three artifact roles before the aspect build; it replaces the previous three
separate `cquery` invocations.

Bazel 8 may report the main repository as either `//package:target` or the
canonical `@@//package:target`. These two main-repository forms are normalized
for graph joins. External canonical repository names are preserved, so labels
from different dependencies cannot be conflated.

The recursive aspect recognizes both the public compatibility `JavaInfo`
provider used by standard `rules_java` wrappers and the private provider used
by some custom Java rules. A selected root is rejected only when neither
provider identity is present. This keeps mixed standard/custom rule graphs
strict without mistaking a provider-identity difference for missing Java data.

The recursive graph retains external targets and their compile, runtime, and
source-artifact relationships. JDT document crawling is intentionally limited
to main-repository checked-in sources, configured generated sources, and source
JARs produced by main-repository targets. External dependency source JARs are
artifact evidence rather than project documents; they are not extracted into
the crawl inventory. This keeps optional or malformed dependency source
archives from failing preparation and prevents dependency sources from
inflating the application graph. A malformed main-repository source JAR still
fails preparation.

### `crawl`

| Field | Required | Values and behavior |
| --- | --- | --- |
| `profile` | No | `"core"` or `"exhaustive"`; default `"exhaustive"`. `core` collects document symbols while relying on the authoritative Bazel graph and bytecode enrichment for dependency, reference, type, call, and artifact relationships. Reference, hover, hierarchy, semantic-token, signature, and diagnostic requests are explicitly recorded as excluded. `exhaustive` requests the complete LSP capability matrix. The tracked large-repository policy uses `core`. |
| `concurrency` | No | Positive integer; default `4`. Number of persistent JDT.LS crawl shards. |
| `resume` | No | Boolean; default `true`. Reuse an exact content-addressed crawl ID when available. `false` forces execution without deleting cached identities. |

### `artifacts`

| Field | Required | Values and behavior |
| --- | --- | --- |
| `concurrency` | No | Integer from `1` through `16`; default `4`. Parsing concurrency in the persistent ASM artifact worker. |
| `maxClasses` | No | Positive integer, `null`, or omitted; default unlimited. When set, caps the number of artifact classes enriched. This changes graph semantics and invalidates incompatible checkpoints/handoffs. |
| `fetchSources` | No | Boolean; default `true`. Enables artifact source retrieval when source artifacts are available. Set `false` for a strictly local/no-fetch run. |
| `classpathManifests` | No | Array of manifest paths; default `[]`. Each relative path is resolved from the config file's directory. Use these to add artifact classpaths not supplied by the detected build roots. |

### `quality`

| Field | Required | Values and behavior |
| --- | --- | --- |
| `failOnFailedBuildRoot` | No | Boolean; default `true` in a config. When `true`, any failed Bazel preparation root or failed JDT/root crawl exits nonzero, preserves diagnostic checkpoints, and does not publish the final `.lbug`. Capability-level partial/timeout observations remain publishable and are qualified in the graph. When `false`, root failures do not by themselves block publication. CLI-only runs retain their historical default of `false`. |

### `checkpoints`

| Field | Required | Values and behavior |
| --- | --- | --- |
| `directory` | No | Non-empty path string, `null`, or omitted. Relative paths resolve from the config directory. `null`/omitted uses `<output>.checkpoints`. |

Crawl results are stored by their 64-character identity under
`<directory>/by-id/lsp-crawl/`. The identity covers source and build-file
contents, semantic configuration, build scope, crawl profile, artifact
manifests, and adapter routing metadata. An exact hit skips LSP startup and RPC
collection; changed inputs create a separate entry instead of replacing the
previous crawl.

## Configuration identity and prepared validation

The semantic configuration hash covers the config name, Bazel build mode and
scope, crawl profile, artifact class limit, source-fetch policy, and resolved
classpath-manifest paths. It is stored with the Bazel handoff, inventory,
checkpoint fingerprints, CLI run, and graph provenance.

Preparation/crawl/artifact concurrency, timeouts, resume choice, checkpoint
location, output path, and failed-root publication policy are operational
controls and do not alter the semantic scope hash. The resolved Bazel labels
and deterministic query are stored separately and validated during a prepared
run. A semantic mismatch requires preparation again.

## CLI overrides with `--config`

Operational overrides are allowed:

```bash
# Preparation-only operational overrides.
npm run index -- prepare-build-model /path/to/repository \
  --config config/default.json \
  --concurrency 2 \
  --timeout-ms 1200000

# Build/crawl operational overrides.
npm run index -- build-index /path/to/repository \
  --config config/default.json \
  --output /tmp/repository.lbug \
  --concurrency 6 \
  --artifact-concurrency 6 \
  --checkpoint-directory /tmp/repository-checkpoints \
  --no-resume
```

With `--config`, semantic CLI flags are rejected rather than silently changing
the requested graph:

- `--build-model-mode`
- `--bazel-target-query`
- `--artifact-max-classes`
- `--no-artifact-source-fetch`
- `--artifact-classpath-manifest`

Without `--config`, the CLI flags remain available. For example:

```bash
npm run index -- build-index /path/to/repository \
  --build-model-mode integrated \
  --bazel-target-query 'set(//application:lib //application:test)' \
  --output /tmp/repository.lbug
```

## Machine-specific settings

Do not put credentials, executable paths, JDK installations, or private
repository authentication in the JSON file. Keep them in the environment or
the tools' normal credential stores. Relevant environment variables include:

- `GITNEXUS_BAZEL_BIN`: explicit `bazel`/`bazelisk` executable path.
- `GITNEXUS_JDT_JAVA_HOME`: JDK home used by JDT.LS.
- `GITNEXUS_OPENSSL3_LIB`: macOS-only OpenSSL 3 library-directory override used
  by installation-time LadybugDB native-addon verification. Normally the
  installer discovers it with `brew --prefix openssl@3`.
- `GITNEXUS_JDT_BAZEL_MODEL_TIMEOUT_MS`: Bazel model timeout for legacy,
  non-configured flows; the config's `bazel.preparation.timeoutMs` controls
  configured preparation.
- `GITNEXUS_BAZEL_MAX_BUFFER_MB`: maximum buffered stdout/stderr for one Bazel
  command, in MiB. The default is `256`; accepted values are `32` through
  `2048`. Increase it only when an unusually large configured graph still
  exceeds the default.
- `GITNEXUS_BAZEL_SOURCE_JAR_CONCURRENCY`: number of source JARs extracted in
  parallel. The default is `4`; accepted values are `1` through `16`.
- `GITNEXUS_BAZEL_SOURCE_JAR_TIMEOUT_MS`: deadline for listing and extracting
  one source JAR, in milliseconds. The default is `120000` (two minutes) and
  the value must be a positive integer. The repository-wide preparation
  deadline still takes precedence.
- `GITNEXUS_LBUG_BUFFER_POOL_MB`: LadybugDB buffer-pool size in MiB. The
  default is `1024` (1 GiB), and the minimum override is `64`.
- `GITNEXUS_LBUG_ROTATE_BATCHES`: positive number of committed COPY fragments
  between staging-connection rotations.

Repository credentials remain in Bazel, `.netrc`, credential helpers, or the
environment expected by the repository. They are neither read from nor stored
in the run configuration.

During `[bazel:source-inventory]`, source JARs are deduplicated globally by
archive content before extraction. Completed extractions are cached under
`.gitnexus/jdtls/bazel-sources/<configuration-hash>/<source-jar-hash>` and are
reused only after the manifest and extracted Java-file hashes validate. The
stage reports `completed/total`, percentage, cache hits, Java-file count, and
elapsed time as work finishes, with a heartbeat every 15 seconds while active.
Each archive is normally extracted with one bounded process regardless of how
many Java documents it contains; a batched JDK fallback is used when `unzip` is
not installed.
The stage also reports its effective main/external target counts, inventory
finalization, and persistence, so work after archive extraction is visible.
This scope correction uses source-inventory schema version 3. Run
`prepare-build-model` once after upgrading; later `prepared` runs can reuse the new
handoff and inventory.

For large inventories, the JDT project preparation consolidates otherwise
target-local source directories into at most 64 package-correct source roots
(additional roots are used only for real package/name collisions). Original
inventory paths and URI mappings are preserved. This bounds Eclipse import and
resource-reconciliation cost without changing the source documents in the
published graph.

## Inspect a completed graph

```bash
# High-level graph summary.
npm run graph:summary -- /tmp/repository.lbug

# Typed read-only graph client.
npm run lbug:read -- /tmp/repository.lbug

# Run the Temporal semantic extractor.
npm run extract -- /tmp/repository.lbug --extractor temporal

# Start the read-only OpenCypher MCP server.
LBUG_REPO=/tmp/repository.lbug npm run mcp:analyzer
```

The analyzer does not mutate the database. Its MCP server rejects write
OpenCypher clauses.

## Query a language server directly

```bash
npm run query -- calls sample_projects/spring-boot-demo \
  --symbol DemoWorkflow --direction outgoing --depth 3

npm run query -- impl sample_projects/spring-boot-demo --symbol DemoWorkflow
npm run query -- hover sample_projects/spring-boot-demo --symbol DemoWorkflow
npm run query -- context sample_projects/spring-boot-demo --symbol DemoWorkflow
```

Use `--file`, `--line`, and `--char` to select a source location. The query CLI
also accepts `--format tree|json|mermaid` and `--language <server>`.

## Development and maintenance

```bash
npm run build
npm test
```

After intentionally changing dependency tarballs under `vendor/npm`, refresh
the vendored lock metadata with:

```bash
node scripts/vendor-lock.mjs
npm ci --offline
```

The vendor script verifies the complete lockfile closure, records local
tarball paths and integrity hashes, and preserves LadybugDB native packages for
supported platforms.
