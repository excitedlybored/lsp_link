# Indexer instructions and run-configuration reference

Run commands from the repository root. Paths shown below are examples; replace
the workspace and output paths with locations on your machine.

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

## Recommended Bazel Java run

In this project, `prebuilt` means **prepared for the indexer with a successful
`bazel-prepare` run**. It does not mean that an ordinary enterprise
`bazel build` is sufficient by itself. An existing successful enterprise build
is still valuable because Bazel can reuse its action cache during preparation.

The required prebuilt sequence is always:

```text
successful enterprise build (optional cache warm-up)
    -> bazel-prepare (required indexer handoff)
    -> build with prebuilt mode (no Bazel commands)
    -> .lbug
```

The default configuration for the core-Java use case is
`private/core-java.json`. It selects Java libraries, Java applications, and
Java tests across the workspace. This naturally retains production,
QA/simulator, and relevant test code while filtering named validation and
reporting targets before configured Bazel analysis.

The `private` directory is ignored by Git. Keep local target labels or other
repository-specific policy there; do not copy those details into tracked
documentation or source code.

Run the indexer workflow in two required phases against the same workspace and
Bazel output cache:

```bash
# 1. Required even after a successful enterprise Bazel build. Resolve the
#    indexer scope, reuse/build artifacts, and write the validated handoff.
npm run index -- bazel-prepare /path/to/repository \
  --config private/core-java.json

# 2. Prebuilt indexing: consume that exact handoff without invoking Bazel.
npm run index -- build /path/to/repository \
  --config private/core-java.json \
  --output /tmp/repository.lbug
```

Run `bazel-prepare` again after changing the semantic configuration, selected
targets, BUILD files, source inputs, generated sources, or relevant Bazel
outputs. Cleaning or relocating the workspace/output cache also invalidates the
handoff. A normal `bazel build` can warm Bazel's cache, but it does not replace
`bazel-prepare`, which generates the target/source inventory required here.

The name `prebuilt` describes the second command only. `bazel-prepare` still
runs the filtered queries and aspect build needed to create indexer-specific
metadata. Once preparation succeeds, `build` in prebuilt mode performs no
`query`, `cquery`, or `bazel build` operation.

Preparation does not use Bazel's `--keep_going` mode. The complete retained
scope must finish configured analysis and the aspect build successfully before
a new handoff is written. Starting a new preparation invalidates the previous
handoff, so a failed attempt cannot be followed by prebuilt indexing of stale
artifacts from an older successful run.

The default policy uses `prebuilt` indexing, the `facts-first` planner,
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
  "name": "core-java",
  "bazel": {
    "buildMode": "prebuilt",
    "scope": {
      "includeTargetPatterns": ["//..."],
      "includeRuleKinds": ["java_library", "java_binary", "java_test"],
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
    "planner": "facts-first",
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
| `buildMode` | No | `"managed"` or `"prebuilt"`; default `"managed"`. `managed` lets `build` run Bazel preparation itself. `prebuilt` makes `build` invoke no Bazel command and requires a valid handoff from `bazel-prepare`. The `bazel-prepare` command itself always performs managed preparation regardless of this value. |
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
`set(...)` expression is passed to `cquery`. The final labels are sorted and
deduplicated. An empty resolved scope is an error.

| Field | Required | Values and behavior |
| --- | --- | --- |
| `includeTargetPatterns` | Yes | Array of Bazel target patterns, for example `["//..."]` or `["//app/...", "//qa/..."]`. May be empty only when `explicitTargets` is non-empty. Each pattern is queried independently. |
| `includeRuleKinds` | Yes | Array of exact Bazel rule-kind names. The core-Java policy uses `java_library`, `java_binary`, and `java_test`. Custom/Starlark kinds can be listed when their names are stable. May be empty when all desired roots are explicit. |
| `explicitTargets` | No | Array of exact Bazel labels; default `[]`. Explicit targets bypass the rule-kind allowlist, but they must resolve to rules and remain subject to target-name and exact-label exclusions. Tag exclusions discovered through an include pattern also apply. An explicitly included label cannot also appear in `excludeLabels`. Use this for a custom Java-producing target that has a nonstandard rule kind. |
| `excludeTargetNamePatterns` | No | Array of JavaScript regular-expression strings matched against only the target-name portion of each label; default `[]`. Invalid regexes are rejected while loading the config. Anchor patterns with `^` or `$` when exact positioning matters. |
| `excludeLabels` | No | Array of exact Bazel labels; default `[]`. Use for known coverage, reporting, validation, or other roots that should never enter configured analysis. |
| `excludeTags` | No | Array of literal Bazel tag values; default `[]`. For every include pattern, a separate unconfigured tag query identifies matching rules for exclusion. |

At least one of `includeTargetPatterns` or `explicitTargets` must be non-empty.
Exclusions are recorded with reasons as provenance, but excluded targets do not
become configured-target evidence nodes. Dependencies of selected roots are
still captured through Bazel `JavaInfo`; the scope controls top-level roots, not
manual pruning of their required classpaths.

### `crawl`

| Field | Required | Values and behavior |
| --- | --- | --- |
| `planner` | No | `"legacy"` or `"facts-first"`; default `"legacy"`. `legacy` preserves the original request schedule. `facts-first` gathers declaration-scoped facts across a complete root before querying semantic-token gaps and is recommended for this Java run. Planner choice participates in semantic/config and checkpoint validation. |
| `concurrency` | No | Positive integer; default `4`. Number of persistent JDT.LS crawl shards. |
| `resume` | No | Boolean; default `true`. Reuse compatible checkpoints when available. `false` starts a new crawl without deleting existing diagnostic checkpoints. |

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

## Configuration identity and prebuilt validation

The semantic configuration hash covers the config name, Bazel build mode and
scope, crawl planner, artifact class limit, source-fetch policy, and resolved
classpath-manifest paths. It is stored with the Bazel handoff, inventory,
checkpoint fingerprints, CLI run, and graph provenance.

Preparation/crawl/artifact concurrency, timeouts, resume choice, checkpoint
location, output path, and failed-root publication policy are operational
controls and do not alter the semantic scope hash. The resolved Bazel labels
and deterministic query are stored separately and validated during a prebuilt
run. A semantic mismatch requires preparation again.

## CLI overrides with `--config`

Operational overrides are allowed:

```bash
# Preparation-only operational overrides.
npm run index -- bazel-prepare /path/to/repository \
  --config private/core-java.json \
  --concurrency 2 \
  --timeout-ms 1200000

# Build/crawl operational overrides.
npm run index -- build /path/to/repository \
  --config private/core-java.json \
  --output /tmp/repository.lbug \
  --concurrency 6 \
  --artifact-concurrency 6 \
  --checkpoint-directory /tmp/repository-checkpoints \
  --no-resume
```

With `--config`, semantic CLI flags are rejected rather than silently changing
the requested graph:

- `--bazel-build-mode`
- `--bazel-target-query`
- `--crawl-planner`
- `--artifact-max-classes`
- `--no-artifact-source-fetch`
- `--artifact-classpath-manifest`

Without `--config`, all legacy CLI flags remain available. For example:

```bash
npm run index -- build /path/to/repository \
  --bazel-build-mode managed \
  --bazel-target-query 'set(//application:lib //application:test)' \
  --crawl-planner facts-first \
  --output /tmp/repository.lbug
```

## Machine-specific settings

Do not put credentials, executable paths, JDK installations, or private
repository authentication in the JSON file. Keep them in the environment or
the tools' normal credential stores. Relevant environment variables include:

- `GITNEXUS_BAZEL_BIN`: explicit `bazel`/`bazelisk` executable path.
- `GITNEXUS_JDT_JAVA_HOME`: JDK home used by JDT.LS.
- `GITNEXUS_JDT_BAZEL_MODEL_TIMEOUT_MS`: Bazel model timeout for legacy,
  non-configured flows; the config's `bazel.preparation.timeoutMs` controls
  configured preparation.
- `GITNEXUS_LBUG_BUFFER_POOL_MB`: LadybugDB buffer-pool size in MiB, minimum 64.
- `GITNEXUS_LBUG_ROTATE_BATCHES`: positive number of committed COPY fragments
  between staging-connection rotations.

Repository credentials remain in Bazel, `.netrc`, credential helpers, or the
environment expected by the repository. They are neither read from nor stored
in the run configuration.

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
