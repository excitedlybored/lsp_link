# Custom Tools & Graph Analyzers (Python)

This directory contains specialized Python tools that **read directly from the persisted `.gitnexus/` knowledge graph database** with zero re-indexing overhead.

---

## 🐍 Prerequisites & Python Environment

Always use `uv` and the `.venv` virtual environment in the root folder:

```bash
# Setup environment & install dependencies via uv:
uv pip install -r custom_tools/requirements.txt
```

---

## 🛠️ Included Python Custom Tools

### 1. Business Flows, Entry & Exit Points Inspector ([`flows_inspector.py`](file:///Users/zijie-machine/code_ai/ide_link/custom_tools/flows_inspector.py))
Reads `.gitnexus/graph.json` directly (executes in ~15ms) and extracts:
- **🏁 Entry Points**: REST `@GetMapping` / `@PostMapping` controllers, CLI handlers, workflow triggers.
- **🛑 Exit Points / Terminal Sinks**: Database repositories (`save()`, `delete()`), Kafka publishers, external API calls.
- **📋 Step-by-Step Execution Traces**: Complete path of intermediate service and activity calls.

```bash
uv run python custom_tools/flows_inspector.py sample_projects/spring-boot-demo
# Or via npm shortcut:
npm run flows -- sample_projects/spring-boot-demo
```

---

### 2. Knowledge Graph Precision Benchmark ([`graph_comparator.py`](file:///Users/zijie-machine/code_ai/ide_link/custom_tools/graph_comparator.py))
Reads the database to benchmark compiler-verified edges (`confidence = 1.0`) vs AST structural edges.

```bash
uv run python custom_tools/graph_comparator.py sample_projects/spring-boot-demo
# Or via npm shortcut:
npm run compare -- sample_projects/spring-boot-demo
```

---

### 3. Direct Knowledge Graph Query CLI ([`query_db.py`](file:///Users/zijie-machine/code_ai/ide_link/custom_tools/query_db.py))
Inspects node distributions, relation types, and caller trees directly from Python.

```bash
# Graph summary:
uv run python custom_tools/query_db.py sample_projects/spring-boot-demo summary

# Outgoing calls for a symbol:
uv run python custom_tools/query_db.py sample_projects/spring-boot-demo calls showExecutionHistory
```

---

## 🚀 Creating a New Python Custom Tool

To create a new custom tool:
1. Create a script in `custom_tools/<tool_name>.py`.
2. Load the database from `Path(project_path) / ".gitnexus" / "graph.json"`.
3. Perform your graph analytics, anomaly detection, or pathfinding algorithms.
