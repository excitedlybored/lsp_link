# Set 1: Standalone LSP Server Daemon (`lsp_server/`)

This directory contains the standalone server launcher for **Eclipse JDT Language Server (`eclipse.jdt.ls`)**.

---

## 1. Start via Shell Script
```bash
./lsp_server/start_server.sh sample_projects/spring-boot-demo
```

## 2. Start via TypeScript
```bash
npx tsx lsp_server/server_launcher.ts sample_projects/spring-boot-demo
```

---

## 3. Direct LSP Query Client (`query.ts`)
You can query the LSP server directly from this folder without going through GitNexus:

```bash
cd lsp_server

# 1. Outgoing / Incoming Call Hierarchy Tree:
npx tsx query.ts calls ../sample_projects/spring-boot-demo --symbol showExecutionHistory

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
