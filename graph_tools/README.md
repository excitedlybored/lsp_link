# graph_tools (Python)

Read-only Ladybug / OpenCypher tools. This package does **not** parse source; it only opens `.gitnexus/lbug` (or `graph.json`) after `npm run analyze`.

Visualizer UI: [`visualizer/`](visualizer/).

```bash
uv pip install -r graph_tools/requirements.txt

npm run flows -- sample_projects/spring-boot-demo
npm run boundaries -- sample_projects/spring-boot-demo
npm run compare -- sample_projects/spring-boot-demo
npm run visualize -- sample_projects/spring-boot-demo

uv run python graph_tools/query_db.py sample_projects/spring-boot-demo summary
```

New scripts belong here. Query with `$params` via `lbug_client.py` (`pip install ladybug`).
