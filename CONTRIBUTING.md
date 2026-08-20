# Contributing to LSP-Link

Thank you for your interest in contributing to **LSP-Link**! This guide outlines how to set up the development environment, run tests, and add new Language Server Protocol (LSP) adapters.

---

## 1. Development Setup

### Prerequisites
- **Node.js**: v20+ or v22+
- **Java**: OpenJDK 21 LTS (recommended for Eclipse JDT.LS)
- **Optional Language Runtimes**: Python 3.10+, LLVM `clangd`, Rust toolchain (`cargo`, `rust-analyzer`)

### Clone & Install
```bash
git clone git@github.com:excitedlybored/lsp_link.git
cd lsp_link

# Install dependencies across all packages
npm install
```

---

## 2. Running Local Commands

### Knowledge Graph Analysis (Set 2)
```bash
# Run full compiler-verified analysis (LSP enabled by default):
npm run analyze ../sample_projects/spring-boot-demo

# Run fast AST-only analysis:
npm run analyze:no-lsp ../sample_projects/spring-boot-demo

# Run side-by-side AST vs LSP benchmark:
npm run compare ../sample_projects/spring-boot-demo
```

### Direct LSP Query CLI (Set 1)
```bash
# Query Outgoing Call Hierarchy:
npm run query calls ../sample_projects/spring-boot-demo --symbol showExecutionHistory

# Query Interface Implementations:
npm run query impl ../sample_projects/spring-boot-demo --symbol PaymentGateway

# Query 360-Degree Compiler Context:
npm run query context ../sample_projects/spring-boot-demo --symbol DemoWorkflow
```

---

## 3. Adding a New Language Adapter

To add a new Language Server adapter:
1. Create a class extending [`BaseStdioLspAdapter`](file:///Users/zijie-machine/code_ai/ide_link/lsp_server/adapters/base-stdio-adapter.ts) in `lsp_server/adapters/<lang>/`.
2. Implement `isAvailable()` and `getLaunchConfig(workspacePath)`.
3. Register the adapter in [`LspAdapterRegistry`](file:///Users/zijie-machine/code_ai/ide_link/lsp_server/registry/lsp-adapter-registry.ts) and add the file extension mapping.
4. Run `npm test` to verify.
