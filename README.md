# LSP-Link: Polyglot Banking LSP Engine & Knowledge Graph

[![CI](https://github.com/excitedlybored/lsp_link/actions/workflows/ci.yml/badge.svg)](https://github.com/excitedlybored/lsp_link/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node: v20+](https://img.shields.io/badge/node-v20%2B-blue.svg)](https://nodejs.org/)
[![Java: OpenJDK 21](https://img.shields.io/badge/java-OpenJDK%2021-orange.svg)](https://adoptium.net/)
[![LSP: 3.17+](https://img.shields.io/badge/LSP-3.17%2B-green.svg)](https://microsoft.github.io/language-server-protocol/)

**LSP-Link** provides enterprise-grade code intelligence, standardized retrieval queries, and compiler-verified knowledge graphs across polyglot banking and financial codebases (**Java / Spring Boot**, **COBOL / Mainframes**, **Python / Quant**, **C++ / HFT**, **Rust**, **TypeScript**, and **C#**).

---

## 🌟 Key Architecture & Highlights

```mermaid
flowchart TD
    subgraph S1 ["Set 1: Standalone LSP Server Daemon & CLI (lsp_server/)"]
        Daemon["Language Server Daemons<br>(JDT.LS, Pyright, Clangd, Rust-Analyzer, Code4z)"]
        Daemon --> QueryCLI["Unified Query Tool (query.ts)<br>• calls (call tree)<br>• impl (interfaces)<br>• hover (types & docs)<br>• context (360° view)"]
    end

    subgraph S2 ["Set 2: Knowledge Graph Ingestion Engine (gitnexus_ts_isolated/)"]
        Pipeline["17-Phase Ingestion Pipeline<br>• Tree-sitter AST Skeletons<br>• Live LSP Semantic Enrichment<br>• Active Conflict Resolution<br>• Leiden Functional Clusters"]
        Pipeline --> LBUG[".gitnexus/lbug Columnar Graph DB"]
    end

    S1 <-->|vscode-jsonrpc JSON-RPC 2.0| S2
```

1. **Two Distinct Sets of Code**:
   - **Set 1: [`lsp_server/`](lsp_server/)**: Standalone Language Server process manager and JSON-RPC query CLI.
   - **Set 2: [`gitnexus_ts_isolated/`](gitnexus_ts_isolated/)**: Isolated GitNexus knowledge graph engine with Tree-sitter parsers and live LSP enrichment.
2. **Polyglot Banking LSP Matrix**:
   - **Java (Spring Boot / Temporal)**: Eclipse JDT.LS + Spring Tools 4.
   - **COBOL (Mainframe / CICS)**: Broadcom Code4z / Che4z + native paragraph/PERFORM AST parser.
   - **Python (Quant / Risk)**: Microsoft Pyright (`pyright-langserver`).
   - **C / C++ (HFT / Order Routing)**: LLVM Clangd.
   - **Rust (Trading Engines)**: Rust-Analyzer.
   - **TypeScript / JS (Portals)**: `typescript-language-server`.
   - **C# (Treasury)**: `csharp-ls` / `OmniSharp`.
3. **Hybrid 2-Tier Ingestion**:
   - **Tier 1 (Tree-sitter)**: Millisecond-fast AST extraction of all files, classes, methods, and line offsets.
   - **Tier 2 (LSP Compiler)**: Resolves dynamic proxies (`Workflow.newActivityStub`), generic overloads (`repo.save(T)`), and polymorphic interfaces (`PaymentGateway`) with 100% compiler precision.
4. **Active Conflict Resolution & Heuristic Pruning**:
   - When compiler ground truth is established, conflicting lower-confidence AST heuristic edges are automatically pruned and replaced.
5. **Resilient Automatic Fallback**:
   - If an external compiler binary is inactive or unavailable, the system silently continues with 100% Tree-sitter AST analysis without failing.

---

## 🚀 Quickstart & Offline Installation

### 1. Zero-Network 1-Step Setup
The repository includes dependencies in [`vendor/`](vendor/) (offline `.tgz` / `.whl` archives) and sources in [`vendor/packages/`](vendor/packages/). No internet or npm registry is required:

```bash
# Clone repository
git clone https://github.com/excitedlybored/lsp_link.git
cd lsp_link

# 1-Step offline setup (installs Node & Python dependencies 100% from vendor/)
./setup.sh
```

---

### 2. Run Multi-Language Example Tests
Validate all three language testbeds (**Java**, **Python**, **TypeScript**) in 1 command:

```bash
# Test all examples:
npm run test:examples

# Or test any specific example:
npm run boundaries -- examples/01_spring_boot_banking
npm run boundaries -- examples/02_python_fastapi_quant
npm run boundaries -- examples/03_typescript_express_gateway
```

---

### 3. Knowledge Graph Indexing & Ingress/Egress Boundaries
```bash
# 1. Index codebase with live LSP compiler verification:
npm run analyze -- sample_projects/spring-boot-demo

# 2. Ingress & Egress Boundary Analysis:
npm run boundaries -- sample_projects/spring-boot-demo

# 3. View Live GitNexus Graph Node Links (Route -> Method -> Callee -> Sinks):
npm run boundaries:links -- sample_projects/spring-boot-demo

# 4. Inspect End-to-End Business Flows & Execution Paths:
npm run flows -- sample_projects/spring-boot-demo

# 5. List all tracked Ingress/Egress SDK signatures:
npm run sdks:list
```

---

### 4. Direct Polyglot LSP Retrieval Queries
```bash
# 1. Trace Outgoing Call Hierarchy:
npm run query -- calls sample_projects/spring-boot-demo --symbol showExecutionHistory

# 2. Find Concrete Implementations of an Interface:
npm run query -- impl sample_projects/spring-boot-demo --symbol PaymentGateway

# 3. Get 360-Degree Compiler Context:
npm run query -- context sample_projects/spring-boot-demo --symbol DemoWorkflow
```

---

## 📊 Benchmark Results: AST vs. LSP on Enterprise Sample

Tested on [`sample_projects/spring-boot-demo`](sample_projects/spring-boot-demo) (augmented with 4 enterprise patterns):

```
========================================================================
📊 Knowledge Graph Difference Summary
========================================================================
| Metric                | Standard AST | LSP-Enriched | Delta     |
|-----------------------|--------------|--------------|-----------|
| Total Nodes           | 421          | 421          | 0 nodes   |
| Total Edges           | 637          | 694          | +57 edges |
| Communities / Clusters| 23           | 22           | 0         |
| Business Flows        | 6            | 5            | 0         |
========================================================================
```

### Key Differences Discovered:
1. **Dynamic Proxy Chaining**:
   ```
   ⚡ [CALLS] OrderFulfillmentWorkflowImpl.processOrder ──► InventoryActivity.reserveInventory
   ⚡ [CALLS] OrderFulfillmentWorkflowImpl.processOrder ──► ShippingActivity.shipOrder
   ```
2. **Method Overload Disambiguation**:
   ```
   ⚡ [CALLS] AuditService.processOrderAudit ──► AuditLogger.log(Order) : void
   ```
3. **Generic Repository Parameter Resolution**:
   ```
   ⚡ [CALLS] AuditService.processOrderAudit ──► GenericRepository.save(T) : T
   ⚡ [CALLS] OrderRepository.saveAll ──► OrderRepository.save(Order) : Order
   ```

---

## 🧠 LadybugDB (`lbug`) Data Structure & Storage

GitNexus persists the knowledge graph in `.gitnexus/lbug/`. Schema: **[`docs/LBUG_DATA_STRUCTURE.md`](docs/LBUG_DATA_STRUCTURE.md)**.

### Hybrid Graph Schema:
- **Node Tables**: `File`, `Folder`, `Class`, `Interface`, `Method`, `Function`, `Struct`, `Trait`, `Property`, `Community`, `Process`.
- **Unified Relationship Table (`CodeRelation`)**:
  - `CALLS`, `IMPLEMENTS`, `EXTENDS`, `ACCESSES`, `MEMBER_OF`, `IN_COMMUNITY`, `ENTRY_POINT_OF`, `STEP_IN`.
  - Properties: `confidence: 1.0` (Compiler ground truth) vs `0.6` (AST heuristic), `reason: STRING`.

```cypher
-- Find all compiler-verified vs heuristic method invocations:
MATCH (:Method)-[r:CodeRelation {type: 'CALLS'}]->(:Method)
RETURN r.confidence, count(r) AS totalEdges
GROUP BY r.confidence;
```

---

## Package boundaries

One repo, three packages (not three remotes):

| Package | Language | Role |
| --- | --- | --- |
| `gitnexus_ts_isolated/` | TypeScript | **Write** `.gitnexus/lbug` (Tree-sitter + LSP) |
| `lsp_server/` | TypeScript | **Talk** to language servers (canonical adapters + query CLI) |
| `graph_tools/` | Python | **Read** Ladybug with OpenCypher (no source parsing) |

Target languages (Java, Python, …) are adapters under `lsp_server/adapters/<lang>/`. Keep copies in the indexer in sync until they import that tree. `graph_tools` must not walk ASTs.

```
lsp_link/
├── lsp_server/
├── gitnexus_ts_isolated/
├── graph_tools/                # Python + visualizer/
├── examples/
├── sample_projects/
├── language_specs/
├── docs/
├── vendor/
├── package.json                # npm workspaces: the two TS packages
├── CONTRIBUTING.md
└── LICENSE
```

Do **not** commit Apereo CAS, Eclipse JDT.LS, or other full upstream trees. Clone those locally; they are gitignored. Query Ladybug with `pip install ladybug` via `graph_tools/lbug_client.py`.

---

## 📄 License

This project is licensed under the [MIT License](LICENSE).
