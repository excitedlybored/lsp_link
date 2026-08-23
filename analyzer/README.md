# analyzer

Python package that **reads** a GitNexus Ladybug DB (`.gitnexus/lbug`). It does not parse source.

Agents should use the **MCP server** (`opencypher_query`, `graph_schema`). CLIs (`query_db.py`, flows, boundaries, visualizer) stay for humans.

## MCP (OpenCypher)

```bash
uv pip install -r analyzer/requirements.txt
# Indexed repo first:
npm run analyze -- /path/to/project

# Stdio MCP (Cursor / any MCP host)
LBUG_REPO=/path/to/project npm run mcp:analyzer
```

This repo’s Cursor config is [`.cursor/mcp.json`](../.cursor/mcp.json). Point `LBUG_REPO` at the tree you indexed (the directory that contains `.gitnexus/lbug`).

Tools:

| Tool | Role |
| --- | --- |
| `graph_schema` | Tables + `CodeRelation` type counts + example MATCH queries |
| `opencypher_query` | Read-only OpenCypher. Use `$name` + `parameters_json`. Cap `limit` (max 500). |

Writes (`CREATE`, `MERGE`, `DELETE`, `SET`, `COPY`, …) are rejected. The DB is opened `read_only`.

## CLI

```bash
uv pip install -r analyzer/requirements.txt
npm run flows -- sample_projects/spring-boot-demo
npm run boundaries -- sample_projects/spring-boot-demo
uv run python analyzer/query_db.py sample_projects/spring-boot-demo summary
```
