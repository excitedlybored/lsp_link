# Analyzer

`analyzer` is the read-only consumer of LSP-native LadybugDB databases. It does
not crawl source, start language servers, or mutate graph data.

Create its input through the single automated indexing command:

```bash
./lsp-link index /path/to/repository
```

That command prepares any build model, reuses or executes the LSP crawl,
enriches and bulk-loads the graph, and publishes
`/path/to/repository/.gitnexus/lsp-lbug`. The analyzer starts only after that
workflow has completed.

## OpenCypher MCP server

```bash
uv pip install -r analyzer/requirements.txt
LBUG_REPO=/path/to/repository/.gitnexus/lsp-lbug npm run mcp:analyzer
```

Available tools:

| Tool | Purpose |
| --- | --- |
| `graph_schema` | List node/relation tables and relation-kind counts |
| `opencypher_query` | Execute bounded, read-only OpenCypher with parameters |

`CREATE`, `MERGE`, `DELETE`, `SET`, `COPY`, and other write clauses are
rejected, and LadybugDB is opened in read-only mode.

## CLI

```bash
npm run graph:summary -- /path/to/repository/.gitnexus/lsp-lbug
npm run lbug:read -- /path/to/repository/.gitnexus/lsp-lbug
npm run extract -- /path/to/repository/.gitnexus/lsp-lbug --extractor temporal
```

The analyzer uses a 4 GiB Ladybug buffer pool by default, matching indexing.
On a memory-constrained host, or to grant a larger pool to a large extraction,
set `GITNEXUS_LBUG_BUFFER_POOL_MB` for the command (minimum `64`):

```bash
GITNEXUS_LBUG_BUFFER_POOL_MB=4096 npm run extract -- \
  /path/to/repository/.gitnexus/lsp-lbug --extractor temporal
```

The typed client exposes exact symbol kinds and ranges, individual
`LspCallSite` observations, occurrence mappings, capability coverage, and the
separate JVM artifact-enrichment model, including typed `LspJvmBinding`
relationships between protocol observations and compiled artifact identities.

Framework-specific interpretation belongs in
[`extractors`](extractors/README.md). Each technology is an isolated semantic
extractor containing evidence queries and Python assembly logic; Temporal is
the first implementation. Its scalable path consumes compiled annotations,
interface relationships, and resolved bytecode calls from a healthy `core`
index; exhaustive LSP evidence is optional source-level enrichment.

The tested 40-root Bazel fixture produced 40/40 confirmed Temporal workflow
contracts and 37/37 source implementations with no missing or extra workflow
files. This is a fixture result, not a universal accuracy claim; every report
retains its evidence-query counts and underlying LadybugDB node identifiers.
