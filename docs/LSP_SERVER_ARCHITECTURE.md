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
nearest owning root. Sessions use distinct workspace-data directories so
classpath state does not leak between roots.

- Maven uses the M2E model imported by JDT LS.
- Gradle uses Buildship import.
- Bazel generates an exact external model from `JavaInfo` compile-time and
  runtime JARs.
- Spring Tools can run beside JDT LS and shares the same build-root classpath.

Bazel model preparation and root crawls use bounded concurrency. Requests
within an individual server session remain serialized. Finished build outputs
are retained; the indexer does not perform implicit workspace cleanup.

## Protocol sequence

```text
initialize -> initialized -> didOpen documents -> capability requests
           -> shutdown -> exit
```

Negotiated capabilities determine which requests are eligible. Unsupported,
failed, timed-out, empty, and successfully observed results are distinct
coverage outcomes rather than silently collapsing to an empty response.

Use `npm run query` for direct interactive requests and `npm run index` for a
repository crawl.
