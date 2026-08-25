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

`indexer/` consumes the registry and adapters to schedule a full crawl. It
normalizes responses, records capability coverage, performs the separate JVM
artifact stage, and writes LadybugDB.

## Java build roots

The registry discovers Maven reactors, Gradle builds, nested Bazel workspaces,
and unmanaged Java roots independently. Each source file is assigned to its
nearest owning root. Roots are materialized as isolated Eclipse projects and
sharded across a bounded number of persistent JDT LS processes. Each logical
server and document retains `buildRootId`; `processShardId` records the shared
physical process without weakening graph provenance.

- Maven uses the M2E model imported by JDT LS.
- Gradle uses Buildship import.
- Bazel generates an exact external model from `JavaInfo` compile-time and
  runtime JARs.
- Maven/Gradle roots use an external Eclipse model when native multi-module
  import is unavailable.
- Spring Tools can run beside a JDT shard and shares its project classpaths.

Bazel model preparation and root crawls use bounded concurrency. Requests
within an individual server session remain serialized. Finished build outputs
are retained; the indexer does not perform implicit workspace cleanup.

JDT LS full-runtime JARs replace Bazel header JARs for navigation while the
compile/runtime/header identities remain available to artifact enrichment.

## Protocol sequence

```text
initialize -> initialized -> didOpen documents -> capability requests
           -> shutdown -> exit
```

Negotiated capabilities determine which requests are eligible. Unsupported,
failed, timed-out, empty, and successfully observed results are distinct
coverage outcomes rather than silently collapsing to an empty response.

One provider compatibility rule is intentionally explicit: JDT LS may return
a JSON-RPC envelope with neither `result` nor `error` for type-definition
requests on Java primitives and synthetic array `length`. Since the LSP result
is nullable and no declaration exists for these constructs, the JDT adapter
normalizes that exact response to `null`. Other malformed responses still fail.

Use `npm run query` for direct interactive requests and `npm run index` for a
repository crawl.
