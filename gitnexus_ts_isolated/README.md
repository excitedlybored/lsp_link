# GitNexus Isolated Core (TypeScript)

This directory contains the **isolated TypeScript source code** for GitNexus's:
1. **Graph Data Model** (`types.ts`)
2. **17-Phase Ingestion Pipeline** (`pipeline.ts` & `pipeline-phases/`)
3. **Tree-sitter AST Queries & Multi-Language Parsers** (`languages/`, `tree-sitter-queries.ts`)

---

## 1. Directory Structure

```
gitnexus_ts_isolated/
├── package.json
├── tsconfig.json
└── src/
    ├── graph/                         # Graph data models & schema contracts
    │   └── types.ts                   # 37 NodeLabels, 35 RelationshipTypes, NodeProperties, Evidence
    ├── graph_impl/                    # In-memory graph structure & import cycle detection
    │   ├── graph.ts
    │   └── import-cycles.ts
    ├── shared/                        # Supported languages & MRO resolution
    │   ├── languages.ts
    │   ├── language-detection.ts
    │   └── mro-strategy.ts
    ├── tree_sitter/                   # Tree-sitter parser initialization & worker adapters
    └── ingestion/                     # Complete 17-Phase analysis pipeline & extractors
        ├── pipeline.ts                # Master pipeline orchestrator
        ├── pipeline-phases/           # 17 phase modules (scan, structure, parse, scopeResolution, etc.)
        ├── tree-sitter-queries.ts     # 100KB+ Tree-sitter AST queries for all languages
        ├── language-config.ts         # Per-language syntactic rules
        ├── language-provider.ts       # AST visitor registration
        ├── languages/                 # 15+ Language Extractors:
        │   ├── java.ts                # Java (Classes, Annotations, Interfaces, Methods)
        │   ├── typescript.ts          # TypeScript & TSX
        │   ├── python.ts              # Python (Classes, Decorators, Functions, Async)
        │   ├── go.ts                  # Go (Structs, Interfaces, Functions, Methods)
        │   ├── rust.ts                # Rust (Structs, Traits, Impls, Macros)
        │   ├── c-cpp.ts               # C / C++ (Classes, Templates, Namespaces, Structs)
        │   ├── csharp.ts              # C# (.NET Namespaces, Classes, Properties)
        │   ├── kotlin.ts              # Kotlin (Classes, Companion Objects, Extensions)
        │   ├── swift.ts               # Swift (Protocols, Extensions, Structs)
        │   ├── ruby.ts                # Ruby (Modules, Classes, Methods)
        │   ├── php.ts                 # PHP (Namespaces, Classes, Traits)
        │   ├── cobol.ts               # COBOL (Programs, Sections, Copybooks)
        │   ├── dart.ts                # Dart (Flutter Classes & Widgets)
        │   └── vue.ts                 # Vue (SFC Script & Template Bindings)
        ├── di-extractors/             # Dependency Injection resolution (Spring DI @Autowired, @Value, etc.)
        ├── route-extractors/          # REST route handlers & fetch clients (HANDLES_ROUTE, FETCHES)
        ├── scope-resolution/          # Scope-based call graph & variable access linker
        ├── cfg/                       # Control Flow Graph (CFG) construction
        └── taint/                     # Inter-procedural taint analysis & summaries
```

---

## 2. Graph Data Model (Single Source of Truth)

Source: [`src/graph/types.ts`](file:///Users/zijie-machine/code_ai/ide_link/gitnexus_ts_isolated/src/graph/types.ts)

- **37 Node Labels**:
  - `Project`, `Package`, `Module`, `Folder`, `File`
  - `Class`, `Interface`, `Enum`, `Record`, `Struct`, `Trait`, `Impl`, `TypeAlias`, `Type`, `Typedef`, `Union`, `Namespace`
  - `Function`, `Method`, `Constructor`, `Property`, `Variable`, `Field`, `Const`, `Static`, `Decorator`, `Annotation`, `Import`
  - `Community`, `Process`, `Route`, `Tool`, `BasicBlock`, `Template`, `Section`, `Delegate`
- **35+ Relationship Types**:
  - **Structural**: `CONTAINS`, `MEMBER_OF`, `DEFINES`, `DECLARES`, `IMPORTS`
  - **Call Graph & Usage**: `CALLS`, `USES`, `ACCESSES`, `FETCHES`, `QUERIES`, `WRAPS`
  - **Inheritance & Hierarchy**: `INHERITS`, `EXTENDS`, `IMPLEMENTS`, `METHOD_OVERRIDES`, `METHOD_IMPLEMENTS`
  - **Framework & DI**: `INJECTS`, `CONDITIONAL_ON`, `ADVISED_BY`, `DECORATES`, `HANDLES_ROUTE`, `HANDLES_TOOL`, `BINDS_EVENT_HANDLER`, `EMITS_EVENT`
  - **Process & Architecture**: `ENTRY_POINT_OF`, `STEP_IN_PROCESS`
  - **Control & Data Flow (PDG)**: `CFG`, `CDG`, `REACHING_DEF`, `TAINTED`, `SANITIZES`, `TAINT_PATH`, `CALL_SUMMARY`

---

## 3. Supported Languages & Tree-Sitter Queries

| Language | Extractor Location | Key AST Constructs Parsed |
| :--- | :--- | :--- |
| **Java** | [`src/ingestion/languages/java.ts`](file:///Users/zijie-machine/code_ai/ide_link/gitnexus_ts_isolated/src/ingestion/languages/java.ts) | Classes, Interfaces, Enums, Records, Methods, Annotations (`@Autowired`, `@WorkflowImpl`), Fields, Invocations |
| **TypeScript / JS** | [`src/ingestion/languages/typescript.ts`](file:///Users/zijie-machine/code_ai/ide_link/gitnexus_ts_isolated/src/ingestion/languages/typescript.ts) | Classes, Interfaces, TypeAliases, Functions, ArrowFunctions, Decorators, JSX/TSX components |
| **Python** | [`src/ingestion/languages/python.ts`](file:///Users/zijie-machine/code_ai/ide_link/gitnexus_ts_isolated/src/ingestion/languages/python.ts) | Classes, Functions, Methods, Decorators, Async defs, Type annotations |
| **Go** | [`src/ingestion/languages/go.ts`](file:///Users/zijie-machine/code_ai/ide_link/gitnexus_ts_isolated/src/ingestion/languages/go.ts) | Packages, Structs, Interfaces, Functions, Receiver Methods, Type specs |
| **Rust** | [`src/ingestion/languages/rust.ts`](file:///Users/zijie-machine/code_ai/ide_link/gitnexus_ts_isolated/src/ingestion/languages/rust.ts) | Structs, Enums, Traits, Impl blocks, Functions, Macros |
| **C / C++** | [`src/ingestion/languages/c-cpp.ts`](file:///Users/zijie-machine/code_ai/ide_link/gitnexus_ts_isolated/src/ingestion/languages/c-cpp.ts) | Namespaces, Classes, Structs, Unions, Templates, Functions, Typedefs |
| **C#** | [`src/ingestion/languages/csharp.ts`](file:///Users/zijie-machine/code_ai/ide_link/gitnexus_ts_isolated/src/ingestion/languages/csharp.ts) | Namespaces, Classes, Interfaces, Properties, Methods, Records |
| **Kotlin** | [`src/ingestion/languages/kotlin.ts`](file:///Users/zijie-machine/code_ai/ide_link/gitnexus_ts_isolated/src/ingestion/languages/kotlin.ts) | Classes, Objects, Companion Objects, Extension Functions, Data Classes |
| **Swift** | [`src/ingestion/languages/swift.ts`](file:///Users/zijie-machine/code_ai/ide_link/gitnexus_ts_isolated/src/ingestion/languages/swift.ts) | Protocols, Structs, Classes, Extensions, Functions |
| **PHP** | [`src/ingestion/languages/php.ts`](file:///Users/zijie-machine/code_ai/ide_link/gitnexus_ts_isolated/src/ingestion/languages/php.ts) | Namespaces, Classes, Traits, Interfaces, Methods |
| **Ruby** | [`src/ingestion/languages/ruby.ts`](file:///Users/zijie-machine/code_ai/ide_link/gitnexus_ts_isolated/src/ingestion/languages/ruby.ts) | Modules, Classes, Methods, Attributes |
| **Dart** | [`src/ingestion/languages/dart.ts`](file:///Users/zijie-machine/code_ai/ide_link/gitnexus_ts_isolated/src/ingestion/languages/dart.ts) | Classes, Mixins, Methods, Flutter Widgets |
| **Vue** | [`src/ingestion/languages/vue.ts`](file:///Users/zijie-machine/code_ai/ide_link/gitnexus_ts_isolated/src/ingestion/languages/vue.ts) | SFC Scripts, Template Event bindings (`@event`), Emitters (`$emit`) |
| **COBOL** | [`src/ingestion/languages/cobol.ts`](file:///Users/zijie-machine/code_ai/ide_link/gitnexus_ts_isolated/src/ingestion/languages/cobol.ts) | Programs, Divisions, Sections, Copybooks |

---

## 4. Running Analysis on Sample Projects

```bash
# 1. Analyze Temporal + Spring Boot Sample Project
./gitnexus_ts_isolated/run_on_sample_projects.sh sample_projects/samples-java/springboot

# 2. Analyze Spring PetClinic
./gitnexus_ts_isolated/run_on_sample_projects.sh sample_projects/spring-petclinic

# 3. Query 360-Degree Symbol Context via GitNexus Engine
node gitnexus/gitnexus/dist/cli/index.js context HelloWorkflow -r samples-java
node gitnexus/gitnexus/dist/cli/index.js context OwnerController -r spring-petclinic
```

