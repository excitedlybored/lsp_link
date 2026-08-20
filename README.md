# IDE Linking & Understanding: Java, Spring Boot & Temporal

This workspace contains the source code repositories and reference implementations for how modern IDEs (like VS Code) understand and link Java, Spring Boot, and Temporal workflows.

---

## Workspace Directory Structure

```
ide_link/
├── gitnexus_ts_isolated/              # Isolated GitNexus Core in Pure TypeScript (Schema, Pipeline & 15+ Tree-sitter Parsers)
├── gitnexus/                          # Full Upstream GitNexus Engine & Web App
├── lsp_runner/                        # Standalone Eclipse JDT.LS IDE Runner & LSP JSON-RPC Client
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
    ├── spring-petclinic/              # Canonical Spring Boot MVC + JPA reference application
    ├── gs-rest-service/               # Official Spring Boot RESTful Web Service guide
    └── samples-java/                  # Temporal Java samples (includes springboot & springboot-basic)
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
