"""Read-only OpenCypher against legacy or LSP-native LadybugDB databases."""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any, Mapping

import ladybug

try:
    from .database import open_read_only_lbug_database, resolve_lbug_path
except ImportError:
    from database import open_read_only_lbug_database, resolve_lbug_path

WRITE_TOKEN = re.compile(
    r"\b(CREATE|MERGE|DELETE|DETACH|SET|DROP|ALTER|COPY|INSTALL|ATTACH|LOAD|CHECKPOINT|EXPORT|IMPORT)\b",
    re.IGNORECASE,
)

DEFAULT_LIMIT = 100
MAX_LIMIT = 500


def resolve_lbug_dir(repo: str | None = None) -> Path:
    """Compatibility alias; the result may be a single ``.lbug`` file."""
    return resolve_lbug_path(repo)


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
    db = open_read_only_lbug_database(db_path)
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
    table_types = {row[0]: row[1] for row in tables["rows"]}
    relation_counts: dict[str, list[list[Any]]] = {}
    if "LspRelation" in table_types:
        relation_counts["LspRelation"] = execute_opencypher(
            "MATCH ()-[r:LspRelation]->() RETURN r.kind AS kind, count(r) AS n ORDER BY n DESC;",
            repo=repo, limit=MAX_LIMIT,
        )["rows"]
    if "JvmRelation" in table_types:
        relation_counts["JvmRelation"] = execute_opencypher(
            "MATCH ()-[r:JvmRelation]->() RETURN r.kind AS kind, count(r) AS n ORDER BY n DESC;",
            repo=repo, limit=MAX_LIMIT,
        )["rows"]
    if "CodeRelation" in table_types:
        relation_counts["CodeRelation"] = execute_opencypher(
            "MATCH ()-[r:CodeRelation]->() RETURN r.type AS type, count(r) AS n ORDER BY n DESC;",
            repo=repo, limit=MAX_LIMIT,
        )["rows"]

    lsp_native = "LspRelation" in relation_counts
    return {
        "database": tables["database"],
        "tables": tables["rows"],
        "schema_family": "lsp-native" if lsp_native else "gitnexus-legacy",
        "relation_kinds": relation_counts,
        "example_queries": (
            [
                "MATCH (s:LspMethodSymbol) RETURN s.name, s.uri, s.startLine LIMIT 20",
                "MATCH (caller)-[h:LspRelation {kind: 'HAS_CALLSITE'}]->(site:LspCallSite) "
                "OPTIONAL MATCH (site)-[r:LspRelation {kind: 'RESOLVES_TO'}]->(callee) "
                "RETURN caller.name, site.startLine, site.startCharacter, callee.name LIMIT 30",
                "MATCH (c:LspCoverage) RETURN c.capability, c.status, c.failureCount, c.timeoutCount LIMIT 50",
                "MATCH (a:JvmArtifact)-[:JvmRelation {kind: 'CONTAINS_CLASS'}]->(c:JvmClass) "
                "RETURN a.coordinate, c.binaryName LIMIT 20",
            ] if lsp_native else [
                "MATCH (c:Class) RETURN c.name, c.filePath LIMIT 20",
                "MATCH (a:Method)-[r:CodeRelation {type: 'CALLS'}]->(b) "
                "RETURN a.name, b.name, r.confidence LIMIT 30",
            ]
        ),
    }


def dumps(payload: dict[str, Any]) -> str:
    return json.dumps(payload, indent=2, default=str)
