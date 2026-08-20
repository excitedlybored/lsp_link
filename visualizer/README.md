# LSP-Link Visualizer

Interactive web-based knowledge graph and execution flow visualizer for LSP-Link.

---

## 🚀 Quickstart

Start the local visualizer web server:

```bash
# Visualize default Spring Boot Demo:
npm run visualize

# Or visualize any specific project / example:
npm run visualize -- examples/01_spring_boot_banking
npm run visualize -- examples/02_python_fastapi_quant
npm run visualize -- examples/03_typescript_express_gateway
```

Open your browser at: **[http://localhost:4040](http://localhost:4040)**

---

## 🌟 Key Features

* **Interactive Graph Exploration**: Pan, zoom, and explore nodes (Classes, Methods, Routes, Flows) with automatic Force-Directed layout (CoSE).
* **Live Search**: Instant substring search across symbols, methods, and filepaths.
* **Entity Inspector**: Click on any node to view its declaration file, line ranges, signatures, and outgoing edges.
* **Polyglot Legend**: Color-coded nodes for Ingress Routes (🟢), Classes/Interfaces (🔵), Methods/Functions (🟣), and Process Flows (🟠).
