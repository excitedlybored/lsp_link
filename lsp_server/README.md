# Standalone LSP Server (`lsp_server/`)

This directory contains the standalone server launcher for **Eclipse JDT Language Server (`eclipse.jdt.ls`)** and adapters for TypeScript, Python, C++, Rust, C#, and COBOL.

## Install after cloning

All Node-based LSP dependencies, including the `tsx`/esbuild binaries for supported host platforms, are vendored in `lsp_server/vendor/`. A fresh clone can therefore install without contacting npmjs or an enterprise Artifactory:

```bash
cd lsp_server
npm install
npm run verify:install
```

The committed `.npmrc` enforces offline installation, so `npm install` and `npm ci` use only the checked-in tarballs. `npm run install:offline` remains available for CI. Do not commit an Artifactory URL or authentication token in this repository; no registry configuration is needed for this package. Java JDT.LS, clangd, rust-analyzer, and the other non-Node language servers remain separately installed system/runtime prerequisites.

---

## 1. Start via Shell Script
```bash
./lsp_server/start_server.sh sample_projects/spring-boot-demo
```

## 2. Start via TypeScript
```bash
npm run server -- ../sample_projects/spring-boot-demo
```

---

## 3. Direct LSP Query Client (`query.ts`)
You can query the LSP server directly from this folder without going through GitNexus:

```bash
cd lsp_server

# 1. Outgoing / Incoming Call Hierarchy Tree:
npm run query -- calls ../sample_projects/spring-boot-demo --symbol showExecutionHistory

# 2. Interface to Concrete Implementations:
npx tsx query.ts impl ../sample_projects/spring-boot-demo --symbol DemoWorkflow

# 3. 360-Degree Compiler Context:
npx tsx query.ts context ../sample_projects/spring-boot-demo --symbol DemoWorkflow
```

---

## Capabilities
- **Runtime**: OpenJDK 21
- **Transport**: JSON-RPC 2.0 over `stdio`
- **Compiler Backends**: Gradle & Maven auto-import
- **Standard Protocol**: LSP 3.16+ (`documentSymbol`, `prepareCallHierarchy`, `implementation`, `hover`)
