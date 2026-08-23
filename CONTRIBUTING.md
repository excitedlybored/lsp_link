# Contributing to LSP-Link

Thank you for your interest in contributing to **LSP-Link**! This guide outlines how to set up the development environment, run tests, and add new Language Server Protocol (LSP) adapters.

---

## 1. Development Setup

### Prerequisites
- **Node.js**: v20+ or v22+
- **Java**: OpenJDK 21 LTS (recommended for Eclipse JDT.LS)
- **Optional Language Runtimes**: Python 3.10+, LLVM `clangd`, Rust toolchain (`cargo`, `rust-analyzer`)

### Clone & install
```bash
git clone git@github.com:excitedlybored/lsp_link.git
cd lsp_link
npm install
```

---

## 2. Running Local Commands

### Knowledge graph (gitnexus_ts_isolated)
```bash
npm run analyze -- sample_projects/spring-boot-demo
npm run analyze:no-lsp -- sample_projects/spring-boot-demo
npm run compare -- sample_projects/spring-boot-demo
```

### LSP query CLI (lsp_server)
```bash
npm run query -- calls sample_projects/spring-boot-demo --symbol showExecutionHistory
npm run query -- impl sample_projects/spring-boot-demo --symbol PaymentGateway
npm run query -- context sample_projects/spring-boot-demo --symbol DemoWorkflow
```

---

## 3. Adding a New Language Adapter

To add a Language Server adapter:
1. Add a class extending `BaseStdioAdapter` in `lsp_server/adapters/<lang>/`.
2. Implement `isAvailable()` and `getLaunchConfig(workspacePath)`.
3. Register it in `lsp_server/registry/lsp-adapter-registry.ts` and map the file extension.
4. Run `npm test`.
