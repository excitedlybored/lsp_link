# Custom Tools & Graph Analyzers

This folder contains specialized, custom tools built on top of the **IDE-Link** knowledge graph and Language Server Protocol engine.

---

## 🛠️ Included Custom Tools

### 1. Business Flows & Entry/Exit Points Inspector ([`flows_inspector.ts`](file:///Users/zijie-machine/code_ai/ide_link/custom_tools/flows_inspector.ts))
Traverses the knowledge graph to extract all:
- **Entry Points**: REST `@GetMapping` / `@PostMapping` controllers, CLI handlers, workflow triggers.
- **Exit Points / Terminal Sinks**: Database repositories (`save()`, `delete()`), Kafka publishers, external API calls.
- **Step-by-Step Execution Traces**: Complete path of intermediate service and activity calls.

```bash
npm run flows -- sample_projects/spring-boot-demo
# Or directly:
npx tsx custom_tools/flows_inspector.ts sample_projects/spring-boot-demo
```

---

### 2. Side-by-Side Graph Comparator ([`graph_comparator.ts`](file:///Users/zijie-machine/code_ai/ide_link/custom_tools/graph_comparator.ts))
Runs both pure Tree-sitter AST and live LSP ingestion on any project to benchmark:
- Compiler edge deltas (`+57 edges`)
- Polymorphic implementation counts
- Execution time comparison

```bash
npm run compare -- sample_projects/spring-boot-demo
# Or directly:
npx tsx custom_tools/graph_comparator.ts sample_projects/spring-boot-demo
```

---

## 🚀 Creating a New Custom Tool

To create a new custom tool:
1. Create a script in `custom_tools/<your_tool_name>.ts`.
2. Import `runPipelineFromRepo` from `../gitnexus_ts_isolated/src/ingestion/pipeline.js` or query `.gitnexus/lbug`.
3. Add a convenience script in root [`package.json`](file:///Users/zijie-machine/code_ai/ide_link/package.json).
