# Analyzer

`analyzer` is the read-only consumer of LSP-native LadybugDB databases. It does
not crawl source, start language servers, or mutate graph data.

## OpenCypher MCP server

```bash
uv pip install -r analyzer/requirements.txt
LBUG_REPO=/tmp/repository.lbug npm run mcp:analyzer
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
npm run graph:summary -- /tmp/repository.lbug
npm run lbug:read -- /tmp/repository.lbug
npm run extract -- /tmp/repository.lbug --extractor temporal
```

The typed client exposes exact symbol kinds and ranges, individual
`LspCallSite` observations, occurrence mappings, capability coverage, and the
separate JVM artifact-enrichment model, including typed `LspJvmBinding`
relationships between protocol observations and compiled artifact identities.

Framework-specific interpretation belongs in
[`extractors`](extractors/README.md). Each technology is an isolated semantic
extractor containing evidence queries and Python assembly logic; Temporal is
the first implementation.
