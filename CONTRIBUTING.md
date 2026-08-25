# Contributing to LSP-Link

Thank you for your interest in contributing to **LSP-Link**! This guide outlines how to set up the development environment, run tests, and add new Language Server Protocol (LSP) adapters.

---

## 1. Development Setup

### Prerequisites
- **Node.js**: v20+ or v22+
- **Java**: OpenJDK 21+ for Eclipse JDT.LS; Java 25 is supported and may be
  selected when required by a project model
- **Analyzer tooling**: `uv` with Python 3.12
- **Optional Language Runtimes**: LLVM `clangd`, Rust toolchain (`cargo`, `rust-analyzer`)

### Clone & install
```bash
git clone git@github.com:excitedlybored/lsp_link.git
cd lsp_link
./install.sh
```

---

## 2. Running Local Commands

### Indexer
```bash
npm run index -- build sample_projects/spring-boot-demo --output /tmp/spring-demo.lbug
npm run graph:summary -- /tmp/spring-demo.lbug
```

Long crawls write resumable checkpoints beside the requested output. Keep
these files while diagnosing or retrying a failed run; deleting them forces the
corresponding LSP or artifact stage to execute again.

### LSP query CLI (`lsp_server/`)
```bash
npm run query -- calls sample_projects/spring-boot-demo --symbol showExecutionHistory
npm run query -- impl sample_projects/spring-boot-demo --symbol PaymentGateway
npm run query -- context sample_projects/spring-boot-demo --symbol DemoWorkflow
```

### Analyzer MCP / Python (`analyzer/`)
```bash
LBUG_REPO=/tmp/spring-demo.lbug npm run mcp:analyzer
npm run extract -- /tmp/spring-demo.lbug --extractor temporal
```

Python only queries an existing `.lbug` database. Language adapters belong in
`lsp_server/adapters/<lang>/`; graph normalization and persistence belong in
`indexer/`.

---

## 3. Adding a New Language Adapter

To add a Language Server adapter:
1. Add a class extending `BaseStdioLspAdapter` in `lsp_server/adapters/<lang>/`.
2. Implement availability and process-launch configuration.
3. Register it in `lsp_server/registry/lsp-adapter-registry.ts` and map the file extension.
4. Run `npm test`.
