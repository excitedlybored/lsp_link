"""Shared LadybugDB path resolution and schema discovery helpers."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any


def resolve_lbug_path(value: str | os.PathLike[str] | None = None) -> Path:
    """Resolve a direct Ladybug database or an indexed project directory.

    LSP-native crawls are commonly emitted as a single ``*.lbug`` database
    file, while the legacy analyzer stores its database at
    ``<project>/.gitnexus/lbug``. Both layouts are first-class inputs.
    """

    raw = str(value or os.environ.get("LBUG_REPO") or os.getcwd()).strip()
    candidate = Path(raw).expanduser().resolve()
    if candidate.exists() and (candidate.is_file() or candidate.name == "lbug"):
        return candidate

    nested = candidate / ".gitnexus" / "lbug"
    if nested.exists():
        return nested

    raise FileNotFoundError(
        f"No LadybugDB found for '{candidate}'. Pass a .lbug file directly, "
        f"or a project containing '{nested.relative_to(candidate)}'."
    )


def table_catalog(connection: Any) -> dict[str, str]:
    """Return Ladybug table names mapped to ``NODE`` or ``REL``."""

    result = connection.execute("CALL show_tables() RETURN name, type;")
    tables: dict[str, str] = {}
    while result.has_next():
        name, table_type = result.get_next()
        tables[str(name)] = str(table_type)
    return tables


def schema_family(tables: dict[str, str]) -> str:
    """Identify the persisted graph contract without guessing from paths."""

    if "LspRelation" in tables:
        return "lsp-native"
    if "CodeRelation" in tables:
        return "gitnexus-legacy"
    return "unknown"
