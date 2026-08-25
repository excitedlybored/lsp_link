# LSP Link

LSP Link crawls source repositories through language servers and writes an
evidence-backed knowledge graph to LadybugDB (`.lbug`). The protocol crawl,
derived call normalization, and JVM artifact enrichment are separate stages.

## Quick start

Requirements:

- Node.js 20 or 22
- A JDK: Java 21 or Java 25
- `uv` and Python 3.12 only when using the Python analyzer

Clone and install. npm dependencies are bundled in this repository; the
installer runs without contacting npm or a configured Artifactory registry.

```bash
git clone <repository-url>
cd ide_link
./install.sh
```

Index a repository. The output path must not already exist.

```bash
npm run index -- build /path/to/repository \
  --output /tmp/repository.lbug \
  --concurrency 4 \
  --artifact-concurrency 4
```

Inspect the resulting graph or run a semantic extractor:

```bash
npm run graph:summary -- /tmp/repository.lbug
npm run extract -- /tmp/repository.lbug --extractor temporal
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

- [Command reference](docs/command.md)
- [Indexer details](indexer/README.md)
- [Language-server and build-import architecture](docs/LSP_SERVER_ARCHITECTURE.md)
- [LadybugDB data model](docs/LBUG_DATA_STRUCTURE.md)
- [Analyzer and extractors](analyzer/README.md)
- [Sample projects](sample_projects/README.md)

Run `npm test` before contributing changes.
