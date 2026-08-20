# IDE Linking & Understanding: Java, Spring Boot & Temporal

This workspace contains the source code repositories and reference implementations for how modern IDEs (like VS Code) understand and link Java, Spring Boot, and Temporal workflows.

---

## Workspace Directory Structure

```
ide_link/
├── lsp_server/                        # [Set 1] Standalone Eclipse JDT.LS Language Server Daemon
├── gitnexus_ts_isolated/              # [Set 2] Isolated GitNexus LSP-Enriched Indexer & Pipeline
├── gitnexus/                          # Full Upstream GitNexus Engine & Web App
├── lsp_runner/                        # Diagnostic Python CLI & Call Tree Visualizer
├── 01_language_server_protocol/
│   ├── eclipse.jdt.ls/                # Eclipse Java Language Server (JDT.LS backend for VS Code)
│   └── lsp4j/                         # LSP Java implementation & JSON-RPC communication
├── 02_ast_analysis/
│   └── javaparser/                    # Java AST parsing, symbol solver, and syntax trees
├── 03_framework_metamodel_spring/
│   └── spring-tools4/                 # Spring Boot Language Server (ST4) & JDT.LS extensions
├── 04_rpc_dynamic_proxy_temporal/
│   └── temporal-sdk-java/             # Temporal Java SDK, Dynamic Proxy Stubs & Spring Boot Starter
└── sample_projects/
    ├── spring-boot-demo/              # Official Spring Boot + Temporal + CloudEvents project
    ├── temporal-pause-resume-compensate/ # Spring Boot Saga compensation sample
    ├── spring-petclinic/              # Canonical Spring Boot MVC + JPA reference application
    ├── gs-rest-service/               # Official Spring Boot RESTful Web Service guide
    └── samples-java/                  # Temporal Java samples (includes springboot & springboot-basic)
```

---

## 🚀 The Two Sets of Code

### Set 1: Standalone LSP Server Daemon & Query Tool ([`lsp_server/`](file:///Users/zijie-machine/code_ai/ide_link/lsp_server))
Runs Eclipse JDT.LS as a standalone, persistent Language Server over OpenJDK 21 via JSON-RPC stdio and provides direct retrieval queries:
```bash
cd lsp_server

# 1. Start Server Daemon:
./start_server.sh ../sample_projects/spring-boot-demo

# 2. Query Call Hierarchy Directly:
npx tsx query.ts calls ../sample_projects/spring-boot-demo --symbol showExecutionHistory

# 3. Query Interface Implementations Directly:
npx tsx query.ts impl ../sample_projects/spring-boot-demo --symbol DemoWorkflow

# 4. Query 360-Degree Compiler Context Directly:
npx tsx query.ts context ../sample_projects/spring-boot-demo --symbol DemoWorkflow
```

### Set 2: Isolated GitNexus LSP-Enriched Indexer ([`gitnexus_ts_isolated/`](file:///Users/zijie-machine/code_ai/ide_link/gitnexus_ts_isolated))
Runs the complete 17-phase GitNexus pipeline with automatic LSP enrichment and graceful fallback, producing compiler-verified `.gitnexus/` knowledge graphs:
```bash
cd gitnexus_ts_isolated

# 1. Run Complete Analyze (LSP enabled by default):
npx tsx src/cli/analyze.ts ../sample_projects/spring-boot-demo

# 2. Run in fast AST-only mode (opt-out):
npx tsx src/cli/analyze.ts ../sample_projects/spring-boot-demo --no-lsp

# 3. Run Side-by-Side Comparison Benchmark:
npx tsx src/cli/compare_graphs.ts ../sample_projects/spring-boot-demo
```

---

## 💡 Architecture Insight: Why IDEs Use LSP for Standardized Code Retrieval

Modern IDEs (VS Code, Cursor, Eclipse) use the **Language Server Protocol (LSP)** to decouple the editor UI from language compilers, standardizing code structure and dependency queries over JSON-RPC:

| Retrieval Target | Standardized LSP Method | What the Compiler Returns |
| :--- | :--- | :--- |
| **Call Graph / Dependencies** | `textDocument/prepareCallHierarchy`<br>`callHierarchy/outgoingCalls`<br>`callHierarchy/incomingCalls` | Exact compiler-resolved caller $\rightarrow$ callee tree with types |
| **Interface Implementations** | `textDocument/implementation` | Concrete classes / Spring beans implementing an interface |
| **Type Hierarchy** | `textDocument/prepareTypeHierarchy`<br>`typeHierarchy/supertypes`<br>`typeHierarchy/subtypes` | True inheritance & polymorphism tree across multi-module JARs |
| **AST File Outline** | `textDocument/documentSymbol` | Hierarchical class, interface, method, and field nodes |
| **Global Workspace Search** | `workspace/symbol` | Workspace-wide symbol index |
| **Type Definition & Hover** | `textDocument/hover` | Generic types (`ResponseEntity<T>`), signatures, and Javadocs |

### Standardized Query CLI in TypeScript ([`lsp_server/query.ts`](file:///Users/zijie-machine/code_ai/ide_link/lsp_server/query.ts))
```bash
cd lsp_server

# 1. Outgoing / Incoming Call Hierarchy Tree
npx tsx query.ts calls <project> --symbol <MethodName> [--direction outgoing|incoming]

# 2. Interface to Concrete Class / Spring Bean Implementations
npx tsx query.ts impl <project> --symbol <InterfaceName>

# 3. 360-Degree Compiler Context
npx tsx query.ts context <project> --symbol <SymbolName>
```

---

## 🧠 LadybugDB (`lbug`) Data Structure & Storage

GitNexus stores its code knowledge graph in an embedded columnar database engine (`.gitnexus/lbug/`).

For full technical specifications, see **[`docs/LBUG_DATA_STRUCTURE.md`](file:///Users/zijie-machine/code_ai/ide_link/docs/LBUG_DATA_STRUCTURE.md)**.

### Hybrid Graph Schema Summary:
1. **Strongly Typed Node Tables**:
   - **Structure**: `File`, `Folder`
   - **Code Elements**: `Class`, `Interface`, `Method`, `Function`, `Struct`, `Trait`, `Enum`, `Property`, `BasicBlock`
   - **Analysis Overlays**: `Community` (Leiden clusters), `Process` (End-to-end execution flows)
2. **Unified Relationship Table (`CodeRelation`)**:
   - All edges (`CALLS`, `IMPLEMENTS`, `EXTENDS`, `ACCESSES`, `STEP_IN`, `IN_COMMUNITY`) connect any node pair with:
     - `confidence`: `1.0` (LSP Compiler Ground Truth) vs `0.6` (Tree-sitter AST heuristic)
     - `reason`: Exact compiler signature provenance.
3. **On-Disk Database Layout**:
   ```
   <repo_root>/.gitnexus/
   ├── lbug/                # LadybugDB / Kùzu Columnar Storage files
   │   ├── catalog.kuzu     # Table schemas & catalog DDL
   │   ├── data.kuzu        # Columnar properties & CSR adjacency lists
   │   └── wal.kuzu         # Write-Ahead Log
   └── gitnexus.json        # Graph manifest & cluster summaries
   ```

---

## ⚡ Real IDE Engine & LSP Server Runner (`lsp_runner/`)

All AST parsing, symbol tables, hovers, type hierarchies, and definitions are driven **100% natively by the live Eclipse JDT Language Server (`eclipse.jdt.ls`)** running OpenJDK 21 over JSON-RPC.

### 1. Run 100% Pure JDT.LS LSP Queries (Symbols, AST, Hovers, Implementations)
```bash
.venv/bin/python -m lsp_runner.pure_lsp_indexer sample_projects/samples-java/springboot
```
- Spawns real Eclipse JDT.LS over OpenJDK 21
- Waits for Gradle `ServiceReady` compilation
- Executes real JSON-RPC queries: `workspace/symbol`, `textDocument/documentSymbol`, `textDocument/hover`, and `textDocument/implementation`.

### 2. Run Interactive IDE Simulation Workflow
```bash
.venv/bin/python -m lsp_runner.ide_simulator sample_projects/samples-java/springboot
```

### 3. Retrieve Live Dependency Call Trees (Incoming & Outgoing)
```bash
# Trace Outgoing Call Tree (What this method calls)
.venv/bin/python -m lsp_runner.call_tree sample_projects/samples-java/springboot \
  --file src/main/java/io/temporal/samples/springboot/SamplesController.java \
  --line 40 --char 15 --direction outgoing

# Trace Incoming Call Tree (Who calls this method)
.venv/bin/python -m lsp_runner.call_tree sample_projects/samples-java/springboot \
  --file src/main/java/io/temporal/samples/springboot/hello/HelloWorkflow.java \
  --line 9 --char 12 --direction incoming
```

### 4. Launch Standalone JDT.LS Server over stdio (For Neovim / Emacs / Custom Clients)
```bash
./lsp_runner/launch_server.sh sample_projects/samples-java/springboot
```

---

## 1. Language Server Protocol (LSP)
- **Directory**: [`01_language_server_protocol`](file:///Users/zijie-machine/code_ai/ide_link/01_language_server_protocol)
- **Repositories**:
  - [`eclipse.jdt.ls`](file:///Users/zijie-machine/code_ai/ide_link/01_language_server_protocol/eclipse.jdt.ls): The actual Java language server powering VS Code's Java extension pack. Handles symbol indexing, type hierarchy resolution, and `textDocument/definition`.
  - [`lsp4j`](file:///Users/zijie-machine/code_ai/ide_link/01_language_server_protocol/lsp4j): Official Eclipse LSP & DAP (Debug Adapter Protocol) bindings in Java over JSON-RPC.

---

## 2. AST Analysis & Symbol Solving
- **Directory**: [`02_ast_analysis`](file:///Users/zijie-machine/code_ai/ide_link/02_ast_analysis)
- **Repositories**:
  - [`javaparser`](file:///Users/zijie-machine/code_ai/ide_link/02_ast_analysis/javaparser): Reference library for generating Java Abstract Syntax Trees (ASTs), traversing nodes, and performing symbol resolution (e.g. mapping string literals and method calls back to method declarations).

---

## 3. Framework Metamodel & Dependency Injection (Spring Boot)
- **Directory**: [`03_framework_metamodel_spring`](file:///Users/zijie-machine/code_ai/ide_link/03_framework_metamodel_spring)
- **Repositories**:
  - [`spring-tools4`](file:///Users/zijie-machine/code_ai/ide_link/03_framework_metamodel_spring/spring-tools4): The engine for Spring Boot IDE tooling:
    - [`spring-boot-language-server`](file:///Users/zijie-machine/code_ai/ide_link/03_framework_metamodel_spring/spring-tools4/headless-services/spring-boot-language-server): Indexes `@Component`, `@Autowired`, `@Value`, and connects Spring symbols to `application.properties`/`application.yml`.
    - [`jdt-ls-extension`](file:///Users/zijie-machine/code_ai/ide_link/03_framework_metamodel_spring/spring-tools4/headless-services/jdt-ls-extension): Injects Spring semantic awareness directly into Eclipse JDT.LS.

---

## 4. RPC & Dynamic Proxy Abstraction (Temporal SDK)
- **Directory**: [`04_rpc_dynamic_proxy_temporal`](file:///Users/zijie-machine/code_ai/ide_link/04_rpc_dynamic_proxy_temporal)
- **Repositories**:
  - [`temporal-sdk-java`](file:///Users/zijie-machine/code_ai/ide_link/04_rpc_dynamic_proxy_temporal/temporal-sdk-java): The Temporal Java SDK implementation:
    - [`temporal-sdk`](file:///Users/zijie-machine/code_ai/ide_link/04_rpc_dynamic_proxy_temporal/temporal-sdk-java/temporal-sdk): Contains dynamic proxy stub generation (`Workflow.newActivityStub`, `WorkflowInvocationHandler`).
    - [`temporal-spring-boot-starter`](file:///Users/zijie-machine/code_ai/ide_link/04_rpc_dynamic_proxy_temporal/temporal-sdk-java/temporal-spring-boot-starter) & [`temporal-spring-boot-autoconfigure`](file:///Users/zijie-machine/code_ai/ide_link/04_rpc_dynamic_proxy_temporal/temporal-sdk-java/temporal-spring-boot-autoconfigure): Auto-configures Spring beans with `@WorkflowImpl` / `@ActivityImpl` to Temporal Workers.
    - [`temporal-workflowcheck`](file:///Users/zijie-machine/code_ai/ide_link/04_rpc_dynamic_proxy_temporal/temporal-sdk-java/temporal-workflowcheck): Static analysis checker for workflow determinism.

---

## 5. Sample Projects
- **Directory**: [`sample_projects`](file:///Users/zijie-machine/code_ai/ide_link/sample_projects)
- **Projects**:
  - [`spring-petclinic`](file:///Users/zijie-machine/code_ai/ide_link/sample_projects/spring-petclinic): Standard Spring Boot MVC + JPA reference application.
  - [`gs-rest-service`](file:///Users/zijie-machine/code_ai/ide_link/sample_projects/gs-rest-service): Official Spring Boot RESTful Web Service starter project.
  - [`samples-java`](file:///Users/zijie-machine/code_ai/ide_link/sample_projects/samples-java): Temporal Java SDK samples with [`springboot`](file:///Users/zijie-machine/code_ai/ide_link/sample_projects/samples-java/springboot) and [`springboot-basic`](file:///Users/zijie-machine/code_ai/ide_link/sample_projects/samples-java/springboot-basic) integration examples.
