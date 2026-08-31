# LSP Link

LSP Link crawls source repositories through language servers and writes an
evidence-backed knowledge graph to LadybugDB (`.lbug`). The protocol crawl,
derived call normalization, and JVM artifact enrichment are separate stages.

## Quick start

Requirements:

- Node.js 20.17+ or 22.9+, with npm 9.2+
- A JDK: Java 21 or Java 25. Eclipse JDT.LS 1.57.0 is bundled; no editor installation is required.
- `uv` and `python3.12` only when using the Python analyzer

Clone the repository. npm dependencies and the Kotlin language server are
bundled, so the public launcher can install missing tools without contacting
npm or a configured Artifactory registry.

```bash
git clone <repository-url>
cd lsp_link
```

Index a repository with one command:

```bash
./lsp-link index /path/to/repository
```

Run it independently of the terminal with:

```bash
./lsp-link index /path/to/repository --background
tail -f /path/to/repository/.gitnexus/index.log
```

The default graph is `/path/to/repository/.gitnexus/lsp-lbug`. The launcher
loads `config/default.json`, installs missing local tools, runs the
`prepare-build-model` stage when configured, and then runs `build-index`.
Advanced CLI options can be appended to the same command.

`index` is the production command. For semantic performance validation without
ASM enrichment or graph publication, use the diagnostic crawl-only command:

```bash
./lsp-link crawl /path/to/repository
```

It writes an `lsp-crawl.checkpoint` suitable for strict batch-versus-LSP
comparison and exits nonzero if a JDT batch server is incomplete. It does not
create or update `.gitnexus/lsp-lbug`.

## Automated indexing flow

The launcher owns the complete sequence; users do not run a separate Bazel
build or either internal stage:

```text
./lsp-link index REPOSITORY
  -> verify/install bundled tools and load configuration
  -> prepare-build-model
       -> detect Bazel roots (skip cleanly when there are none)
       -> discover and filter the configured target scope
       -> run the scoped Bazel aspect build
       -> validate and write the reusable indexer handoff
  -> build-index
       -> inventory repository documents and calculate the crawl-cache ID
       -> reuse exact cached crawl results or run the required language servers
       -> normalize logical calls and enrich JVM artifact evidence
       -> bulk-load nodes and relationships into a staging database
       -> atomically publish .gitnexus/lsp-lbug
```

If the repository was already built, Bazel automatically reuses compatible
action-cache entries during `prepare-build-model`. That existing build is a
useful cache warm-up, but it does not contain the indexer-specific aspect
metadata and therefore does not replace preparation. On a repeated identical
index run, the content-addressed crawl cache also avoids repeating LSP work.
The default `prepared` policy exposes preparation as its own logged process;
an advanced `integrated` policy executes the same preparation logic inside
`build-index` without changing the public command.

Inspect the resulting graph or run a semantic extractor:

```bash
npm run graph:summary -- /path/to/repository/.gitnexus/lsp-lbug
npm run extract -- /path/to/repository/.gitnexus/lsp-lbug --extractor temporal
```

The indexer saves resumable checkpoints beside the output. Re-run the same
command to resume compatible work. Use `--no-resume` for a deliberately fresh
crawl, or `--checkpoint-directory PATH` to store checkpoints elsewhere.

## Repository layout

| Directory | Purpose |
| --- | --- |
| [`lsp_server/`](lsp_server/) | Language-server adapters and build import |
| [`indexer/`](indexer/) | Crawl orchestration, normalization, artifact enrichment, and LadybugDB writes |
| [`analyzer/`](analyzer/) | Read-only graph queries and semantic extractors |
| [`sample_projects/`](sample_projects/) | Runnable fixtures and larger test repositories |
| [`docs/`](docs/) | Architecture, schema, commands, and reference notes |

## Documentation

- [Indexer instructions and configuration reference](docs/instructions.md)
- [Indexer details](indexer/README.md)
- [Language-server and build-import architecture](docs/LSP_SERVER_ARCHITECTURE.md)
- [LadybugDB data model](docs/LBUG_DATA_STRUCTURE.md)
- [Analyzer and extractors](analyzer/README.md)
- [Sample projects](sample_projects/README.md)

Run `npm test` before contributing changes.
