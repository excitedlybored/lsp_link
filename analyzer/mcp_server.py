#!/usr/bin/env python3
"""MCP stdio server: OpenCypher over GitNexus Ladybug (`.gitnexus/lbug`)."""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

_ROOT = Path(__file__).resolve().parent
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from mcp.server.fastmcp import FastMCP

from query import dumps, execute_opencypher
from query import graph_schema as load_graph_schema

mcp = FastMCP(
    "lbug-analyzer",
    instructions=(
        "Query the GitNexus knowledge graph in .gitnexus/lbug with read-only OpenCypher. "
        "Call graph_schema first, then opencypher_query. Bind values with $name and parameters_json. "
        "Edges are CodeRelation with a type property (CALLS, IMPLEMENTS, …). "
        "Default repo is LBUG_REPO or the process cwd."
    ),
)


@mcp.tool()
def graph_schema(repo: str = "") -> str:
    """List Ladybug node/rel tables and CodeRelation type counts. Call before writing Cypher."""
    try:
        return dumps(load_graph_schema(repo or None))
    except Exception as exc:
        return dumps({"error": str(exc)})


@mcp.tool()
def opencypher_query(
    cypher: str,
    repo: str = "",
    parameters_json: str = "{}",
    limit: int = 100,
) -> str:
    """Run read-only OpenCypher against .gitnexus/lbug.

    Use $param in cypher and pass JSON object parameters_json, e.g. {"needle": "login"}.
    Writes (CREATE/MERGE/DELETE/SET/COPY/…) are rejected.
    """
    try:
        params: dict[str, Any] = json.loads(parameters_json or "{}")
        if not isinstance(params, dict):
            raise ValueError("parameters_json must be a JSON object")
        payload = execute_opencypher(
            cypher,
            repo=repo or None,
            parameters=params or None,
            limit=limit,
        )
        return dumps(payload)
    except Exception as exc:
        return dumps({"error": str(exc), "cypher": cypher})


def main() -> None:
    mcp.run(transport="stdio")


if __name__ == "__main__":
    main()
