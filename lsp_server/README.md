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

## Capabilities
- **Runtime**: OpenJDK 21
- **Transport**: JSON-RPC 2.0 over `stdio`
- **Compiler Backends**: Gradle & Maven auto-import
- **Standard Protocol**: LSP 3.16+ (`documentSymbol`, `prepareCallHierarchy`, `implementation`, `hover`)
