# LadybugDB (`lbug`) Data Structure & Storage Architecture

LadybugDB (`lbug`) is the embedded, columnar graph database engine powering GitNexus. It stores the semantic knowledge graph of a codebase directly on disk inside `.gitnexus/lbug/`.

---

## 1. Architectural Philosophy: Hybrid Graph Schema

GitNexus uses a **Hybrid Schema**:
1. **Strongly Typed Node Tables**: Every code element type (`File`, `Class`, `Interface`, `Method`, `Function`, `Community`, `Process`) gets a dedicated, indexed node table with schema constraints.
2. **Single Unified Relationship Table (`CodeRelation`)**: All graph edges are modeled through a single relationship table with a `type`, `confidence`, and `reason` column.

This allows querying the graph naturally using OpenCypher:
```cypher
MATCH (c:Class)-[r:CodeRelation {type: 'IMPLEMENTS'}]->(i:Interface)
RETURN c.name, i.name, r.confidence, r.reason;
```

```
┌────────────────────────────────────────────────────────┐
│               Knowledge Graph Database                 │
│                                                        │
│  ┌──────────────┐    CodeRelation [CALLS]     ┌──────────────┐
│  │ Method Node  │ ──────────────────────────► │ Method Node  │
│  └──────────────┘                             └──────────────┘
│         │                                            │
│         │ CodeRelation [MEMBER_OF]                   │ CodeRelation [STEP_IN]
│         ▼                                            ▼
│  ┌──────────────┐                             ┌──────────────┐
│  │  Class Node  │                             │ Process Node │
│  └──────────────┘                             └──────────────┘
└────────────────────────────────────────────────────────┘
```

---

## 2. Node Tables & Schema Definitions

Node table DDL definitions are defined in [`src/lbug/schema.ts`](file:///Users/zijie-machine/code_ai/ide_link/gitnexus_ts_isolated/src/lbug/schema.ts).

### A. Primary Code & Structural Nodes

| Table Name | Description | Key Properties |
| :--- | :--- | :--- |
| **`File`** | Source code file | `id` (PK), `name`, `filePath`, `content` |
| **`Folder`** | Directory structure | `id` (PK), `name`, `filePath` |
| **`Class`** | OOP class declaration | `id` (PK), `name`, `filePath`, `startLine`, `endLine`, `isExported`, `frameworkAnnotations` (`STRING[]`), `content`, `description` |
| **`Interface`** | Interface contract | `id` (PK), `name`, `filePath`, `startLine`, `endLine`, `isExported`, `content`, `description` |
| **`Method`** | Class/Interface member method | `id` (PK), `name`, `filePath`, `startLine`, `endLine`, `isExported`, `parameterCount`, `returnType`, `content`, `description` |
| **`Function`** | Standalone / module function | `id` (PK), `name`, `filePath`, `startLine`, `endLine`, `isExported`, `content`, `description` |
| **`CodeElement`** | Generic unclassified code element | `id` (PK), `name`, `filePath`, `startLine`, `endLine`, `isExported`, `content`, `description` |

---

### B. Multi-Language & Polyglot Nodes

GitNexus includes dedicated tables for specific language constructs:

| Table Name | Supported Languages | Description |
| :--- | :--- | :--- |
| **`Struct`** | Go, Rust, C, C++ | Struct data type |
| **`Trait`** / **`Impl`** | Rust, PHP, Scala | Rust traits, implementations, and PHP traits |
| **`Enum`** | Java, TypeScript, Rust, C++, C# | Enumerated types |
| **`Namespace`** | C++, C#, PHP | Namespace hierarchies |
| **`Property`** | TypeScript, Java, C#, PHP | Class/Object field definitions (`isDetail` flag for text search) |
| **`Variable`** / **`Const`** | All languages | Global/module-level variables and constants |
| **`Section`** / **`Paragraph`** | COBOL | COBOL divisions, sections, and paragraphs |
| **`BasicBlock`** | All (PDG / CFG) | Intra-procedural control flow node for Program Dependence Graphs |

---

### C. Analysis Overlays (Synthesized during Ingestion)

| Table Name | Phase Origin | Description | Key Properties |
| :--- | :--- | :--- | :--- |
| **`Community`** | `communitiesPhase` (Leiden Clustering) | Semantic functional cluster / domain boundary | `id` (PK), `label`, `heuristicLabel`, `keywords` (`STRING[]`), `cohesion` (`DOUBLE`), `symbolCount` (`INT32`) |
| **`Process`** | `processesPhase` (DFS Flow Tracing) | End-to-end business execution flow (e.g. `OrderController → PaymentProcessor → StripeGateway`) | `id` (PK), `label`, `heuristicLabel`, `processType` (`intra_community` / `cross_community`), `stepCount`, `communities` (`STRING[]`), `entryPointId`, `terminalId` |

---

## 3. Relationship Table: `CodeRelation`

All edges in `lbug` are stored in the `CodeRelation` table with source/target endpoints across any pair of node tables.

### Relationship Schema DDL:
```sql
CREATE REL TABLE CodeRelation (
  FROM <SourceNodeTable> TO <TargetNodeTable>,
  id STRING,
  type STRING,
  confidence DOUBLE,
  reason STRING,
  PRIMARY KEY (id)
);
```

### Supported Relationship Types (`type`):

| Edge Type | Typical Source $\rightarrow$ Target | Description & Provenance |
| :--- | :--- | :--- |
| **`CALLS`** | `Method` $\rightarrow$ `Method` / `Class` | Method/function invocation. Backed by LSP compiler (`confidence: 1.0`) or Tree-sitter heuristic (`0.6`). |
| **`IMPLEMENTS`** | `Class` $\rightarrow$ `Interface` | Concrete class implementing an interface contract. |
| **`EXTENDS`** | `Class` $\rightarrow$ `Class` | Class inheritance hierarchy. |
| **`ACCESSES`** | `Method` $\rightarrow$ `Property` / `Variable` | Field/variable reads and writes. |
| **`CONTAINS`** | `File` $\rightarrow$ `Class` / `Function` | Lexical enclosure in source files. |
| **`MEMBER_OF`** | `Method` $\rightarrow$ `Class` | Method belonging to a class/struct. |
| **`IN_COMMUNITY`** | `Method` / `Class` $\rightarrow$ `Community` | Node membership in a Leiden functional cluster. |
| **`ENTRY_POINT_OF`** | `Method` $\rightarrow$ `Process` | Method serving as the root trigger of a business flow. |
| **`STEP_IN`** | `Method` $\rightarrow$ `Process` | Intermediate step in an execution trace. |
| **`CFG_NEXT`** | `BasicBlock` $\rightarrow$ `BasicBlock` | Intra-procedural control flow graph edge (PDG). |
| **`REACHING_DEF`** | `BasicBlock` $\rightarrow$ `BasicBlock` | Data-flow reaching definition edge with variable tracking. |

---

## 4. Confidence & Provenance Tracking

Every edge carries a `confidence` (`DOUBLE`) and a human-readable `reason` (`STRING`):

```json
{
  "id": "rel:lsp_call:Method:src/PaymentProcessor.java:executeCheckout->Method:src/PaymentGateway.java:processPayment",
  "sourceId": "Method:src/PaymentProcessor.java:executeCheckout#2",
  "targetId": "Method:src/PaymentGateway.java:processPayment#2",
  "type": "CALLS",
  "confidence": 1.0,
  "reason": "LSP: JDT.LS Call Hierarchy (processPayment(String, double) : boolean)"
}
```

- **`confidence: 1.0`**: Verified by the actual language compiler (LSP / JDT.LS).
- **`confidence: 0.6 - 0.7`**: Heuristic lexical AST match from Tree-sitter.

---

## 5. Physical On-Disk Layout

When `gitnexus analyze <path>` runs, it generates the following directory structure inside the target repository:

```
<project_root>/.gitnexus/
├── lbug/                     # LadybugDB / Kùzu Columnar Storage
│   ├── catalog.kuzu          # Node/Rel table metadata and schema catalog
│   ├── data.kuzu             # Columnar node properties & CSR adjacency lists
│   ├── metadata.kuzu         # Block headers and transaction sequence
│   └── wal.kuzu              # Write-Ahead Log for crash resilience
│
├── gitnexus.json             # Manifest metadata & summary snapshot
└── sidecar.json              # Sidecar process state (if active)
```

---

## 6. Example Cypher Queries

### Find all cross-community method calls:
```cypher
MATCH (m1:Method)-[r:CodeRelation {type: 'CALLS'}]->(m2:Method),
      (m1)-[:CodeRelation {type: 'IN_COMMUNITY'}]->(c1:Community),
      (m2)-[:CodeRelation {type: 'IN_COMMUNITY'}]->(c2:Community)
WHERE c1.id <> c2.id
RETURN m1.name, c1.label, m2.name, c2.label, r.reason;
```

### Trace the complete execution path of a Business Process:
```cypher
MATCH (p:Process {id: 'proc_handleCheckout'})<-[s:CodeRelation {type: 'STEP_IN'}]-(m:Method)
RETURN m.name, m.filePath, m.startLine
ORDER BY s.step ASC;
```

### Find all compiler-verified vs heuristic call sites:
```cypher
MATCH (:Method)-[r:CodeRelation {type: 'CALLS'}]->(:Method)
RETURN r.confidence, count(r) AS totalEdges
GROUP BY r.confidence;
```
