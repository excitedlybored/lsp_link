"""Read-only OpenCypher against a GitNexus Ladybug (`.gitnexus/lbug`) directory."""

from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import Any, Mapping

import ladybug

WRITE_TOKEN = re.compile(
    r"\b(CREATE|MERGE|DELETE|DETACH|SET|DROP|ALTER|COPY|INSTALL|ATTACH|LOAD|CHECKPOINT|EXPORT|IMPORT)\b",
    re.IGNORECASE,
)

DEFAULT_LIMIT = 100
MAX_LIMIT = 500


def resolve_lbug_dir(repo: str | None = None) -> Path:
    raw = (repo or os.environ.get("LBUG_REPO") or os.getcwd()).strip()
    root = Path(raw).expanduser().resolve()
    if root.name == "lbug" and root.is_dir():
        return root
    nested = root / ".gitnexus" / "lbug"
    if nested.exists():
        return nested
    raise FileNotFoundError(
        f"No Ladybug DB at {nested}. Run `npm run analyze -- {root}` first, "
        "or pass repo= / set LBUG_REPO to an indexed project."
    )


def assert_read_only_cypher(cypher: str) -> None:
    if WRITE_TOKEN.search(cypher):
        raise ValueError(
            "Only read-only OpenCypher is allowed (MATCH / RETURN / CALL show_*). "
            "Refusing CREATE/MERGE/DELETE/SET/COPY/…"
        )


def _jsonable(value: Any) -> Any:
    if value is None or isinstance(value, (bool, int, float, str)):
        return value
    if isinstance(value, (list, tuple)):
        return [_jsonable(v) for v in value]
    if isinstance(value, dict):
        return {str(k): _jsonable(v) for k, v in value.items()}
    return str(value)


def execute_opencypher(
    cypher: str,
    *,
    repo: str | None = None,
    parameters: Mapping[str, Any] | None = None,
    limit: int = DEFAULT_LIMIT,
) -> dict[str, Any]:
    assert_read_only_cypher(cypher)
    cap = max(1, min(int(limit), MAX_LIMIT))
    db_path = resolve_lbug_dir(repo)
    db = ladybug.Database(str(db_path), read_only=True)
    conn = ladybug.Connection(db)
    try:
        params = dict(parameters) if parameters else None
        if params:
            result = conn.execute(cypher, parameters=params)
        else:
            result = conn.execute(cypher)
        columns: list[str] = []
        if hasattr(result, "get_column_names"):
            columns = list(result.get_column_names() or [])
        rows: list[list[Any]] = []
        truncated = False
        while result.has_next():
            if len(rows) >= cap:
                truncated = True
                break
            rows.append(_jsonable(list(result.get_next())))
        return {
            "database": str(db_path),
            "columns": columns,
            "rows": rows,
            "row_count": len(rows),
            "truncated": truncated,
            "limit": cap,
        }
    finally:
        closer = getattr(conn, "close", None)
        if callable(closer):
            closer()
        closer = getattr(db, "close", None)
        if callable(closer):
            closer()


def graph_schema(repo: str | None = None) -> dict[str, Any]:
    tables = execute_opencypher(
        "CALL show_tables() RETURN name, type;",
        repo=repo,
        limit=MAX_LIMIT,
    )
    rels = execute_opencypher(
        "MATCH ()-[r:CodeRelation]->() RETURN r.type AS type, count(r) AS n ORDER BY n DESC;",
        repo=repo,
        limit=MAX_LIMIT,
    )
    return {
        "database": tables["database"],
        "tables": tables["rows"],
        "code_relation_types": rels["rows"],
        "example_queries": [
            "MATCH (c:Class) RETURN c.name, c.filePath LIMIT 20",
            "MATCH (a:Method)-[r:CodeRelation {type: 'CALLS'}]->(b) "
            "RETURN a.name, b.name, r.confidence LIMIT 30",
            "MATCH (n) WHERE n.name CONTAINS $needle RETURN labels(n), n.name, n.filePath LIMIT 20",
        ],
    }


def dumps(payload: dict[str, Any]) -> str:
    return json.dumps(payload, indent=2, default=str)
