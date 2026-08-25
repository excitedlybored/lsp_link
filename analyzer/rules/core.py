"""Generic execution layer for declarative LadybugDB rule packs."""

from __future__ import annotations

import importlib
import json
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Mapping, Optional

try:
    from analyzer.lbug_client import LadybugClient
    from analyzer.query import assert_read_only_cypher
except ImportError:
    from lbug_client import LadybugClient
    from query import assert_read_only_cypher


@dataclass(frozen=True)
class QueryRule:
    id: str
    description: str
    category: str
    cypher: str
    parameters: Mapping[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class RulePack:
    id: str
    version: str
    description: str
    required_tables: tuple[str, ...]
    queries: tuple[QueryRule, ...]
    assembler_module: Optional[str] = None


@dataclass
class QueryResult:
    rule_id: str
    description: str
    category: str
    columns: list[str]
    rows: list[dict[str, Any]]


@dataclass
class RulePipelineReport:
    pack_id: str
    pack_version: str
    database: str
    generated_at: str
    summary: dict[str, Any]
    findings: dict[str, Any]
    query_results: dict[str, QueryResult]

    def to_dict(self, *, include_raw: bool = False) -> dict[str, Any]:
        payload = {
            "pack": {"id": self.pack_id, "version": self.pack_version},
            "database": self.database,
            "generatedAt": self.generated_at,
            "summary": self.summary,
            "findings": self.findings,
        }
        if include_raw:
            payload["queryResults"] = {
                key: asdict(result) for key, result in self.query_results.items()
            }
        return payload


Assembler = Callable[[Mapping[str, QueryResult]], tuple[dict[str, Any], dict[str, Any]]]


class RuleEngine:
    """Execute a pack's read-only queries, then assemble domain findings."""

    def __init__(self, database_path: str):
        self.database_path = database_path

    def run(self, pack: RulePack) -> RulePipelineReport:
        with LadybugClient(self.database_path) as client:
            if client.schema != "lsp-native":
                raise RuntimeError(
                    f"Rule packs require the LSP-native schema; found {client.schema!r}"
                )
            missing = [table for table in pack.required_tables if table not in client.tables]
            if missing:
                raise RuntimeError(f"Rule pack {pack.id!r} requires missing tables: {missing}")

            results = {
                rule.id: self._execute(client, rule)
                for rule in pack.queries
            }
            assembler = self._load_assembler(pack)
            summary, findings = assembler(results)
            return RulePipelineReport(
                pack_id=pack.id,
                pack_version=pack.version,
                database=str(client.db_path),
                generated_at=datetime.now(timezone.utc).isoformat(),
                summary=summary,
                findings=findings,
                query_results=results,
            )

    @staticmethod
    def _execute(client: LadybugClient, rule: QueryRule) -> QueryResult:
        assert_read_only_cypher(rule.cypher)
        try:
            result = (
                client.conn.execute(rule.cypher, parameters=dict(rule.parameters))
                if rule.parameters else client.conn.execute(rule.cypher)
            )
        except Exception as error:
            raise RuntimeError(f"Rule {rule.id!r} failed: {error}") from error
        columns = [str(column) for column in result.get_column_names()]
        rows: list[dict[str, Any]] = []
        while result.has_next():
            values = result.get_next()
            rows.append({columns[index]: values[index] for index in range(len(columns))})
        return QueryResult(
            rule_id=rule.id,
            description=rule.description,
            category=rule.category,
            columns=columns,
            rows=rows,
        )

    @staticmethod
    def _load_assembler(pack: RulePack) -> Assembler:
        if not pack.assembler_module:
            return _raw_assembler
        module = importlib.import_module(pack.assembler_module)
        assembler = getattr(module, "assemble", None)
        if not callable(assembler):
            raise RuntimeError(f"{pack.assembler_module} does not export assemble(results)")
        return assembler


def _raw_assembler(results: Mapping[str, QueryResult]) -> tuple[dict[str, Any], dict[str, Any]]:
    counts = {rule_id: len(result.rows) for rule_id, result in results.items()}
    return {"ruleCounts": counts}, {"rules": {key: value.rows for key, value in results.items()}}


def load_rule_pack(pack_id: str) -> RulePack:
    """Load ``analyzer/rules/packs/<pack_id>/pack.json`` and its Cypher files."""

    if not pack_id.replace("-", "_").isalnum():
        raise ValueError(f"Invalid rule-pack id: {pack_id!r}")
    pack_dir = Path(__file__).parent / "packs" / pack_id
    manifest_path = pack_dir / "pack.json"
    if not manifest_path.is_file():
        available = sorted(path.parent.name for path in (Path(__file__).parent / "packs").glob("*/pack.json"))
        raise FileNotFoundError(f"Unknown rule pack {pack_id!r}; available: {available}")

    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest.get("id") != pack_id:
        raise ValueError(
            f"Rule-pack manifest id {manifest.get('id')!r} does not match folder {pack_id!r}"
        )
    if manifest.get("schemaVersion") != 1:
        raise ValueError(
            f"Rule pack {pack_id!r} uses unsupported schemaVersion "
            f"{manifest.get('schemaVersion')!r}; expected 1"
        )
    queries = []
    query_ids: set[str] = set()
    for entry in manifest["queries"]:
        if entry["id"] in query_ids:
            raise ValueError(f"Rule pack {pack_id!r} repeats query id {entry['id']!r}")
        query_ids.add(entry["id"])
        query_path = (pack_dir / entry["file"]).resolve()
        if pack_dir.resolve() not in query_path.parents:
            raise ValueError(f"Rule query escapes its pack directory: {entry['file']!r}")
        if not query_path.is_file():
            raise FileNotFoundError(f"Rule query does not exist: {query_path}")
        queries.append(QueryRule(
            id=entry["id"],
            description=entry["description"],
            category=entry["category"],
            cypher=query_path.read_text(encoding="utf-8").strip(),
            parameters=entry.get("parameters", {}),
        ))
    return RulePack(
        id=manifest["id"],
        version=manifest["version"],
        description=manifest["description"],
        required_tables=tuple(manifest.get("requiredTables", [])),
        queries=tuple(queries),
        assembler_module=manifest.get("assemblerModule"),
    )
