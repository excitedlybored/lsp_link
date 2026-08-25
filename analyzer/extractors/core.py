"""Generic execution layer for declarative LadybugDB semantic extractors."""

from __future__ import annotations

import importlib
import json
import re
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
class EvidenceQuery:
    id: str
    description: str
    category: str
    cypher: str
    parameters: Mapping[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class SemanticExtractor:
    id: str
    version: str
    description: str
    data_source: str
    identity_policy: str
    semantic_types: Mapping[str, str]
    required_tables: tuple[str, ...]
    queries: tuple[EvidenceQuery, ...]
    assembler_module: Optional[str] = None


@dataclass
class QueryResult:
    query_id: str
    description: str
    category: str
    columns: list[str]
    rows: list[dict[str, Any]]


@dataclass
class ExtractionReport:
    extractor_id: str
    extractor_version: str
    data_source: str
    identity_policy: str
    semantic_types: Mapping[str, str]
    database: str
    generated_at: str
    summary: dict[str, Any]
    findings: dict[str, Any]
    query_results: dict[str, QueryResult]

    def to_dict(self, *, include_raw: bool = False) -> dict[str, Any]:
        payload = {
            "extractor": {
                "id": self.extractor_id,
                "version": self.extractor_version,
                "dataSource": self.data_source,
                "identityPolicy": self.identity_policy,
                "semanticTypes": dict(self.semantic_types),
            },
            "database": self.database,
            "generatedAt": self.generated_at,
            "summary": self.summary,
            "findings": self.findings,
        }
        if include_raw:
            payload["evidenceQueryResults"] = {
                key: asdict(result) for key, result in self.query_results.items()
            }
        return payload


Assembler = Callable[[Mapping[str, QueryResult]], tuple[dict[str, Any], dict[str, Any]]]


class ExtractionPipeline:
    """Execute an extractor's evidence queries, then assemble domain findings."""

    def __init__(self, database_path: str):
        self.database_path = database_path

    def run(self, extractor: SemanticExtractor) -> ExtractionReport:
        with LadybugClient(self.database_path) as client:
            if client.schema != "lsp-native":
                raise RuntimeError(
                    f"Semantic extractors require the LSP-native schema; found {client.schema!r}"
                )
            missing = [
                table for table in extractor.required_tables if table not in client.tables
            ]
            if missing:
                raise RuntimeError(
                    f"Extractor {extractor.id!r} requires missing tables: {missing}"
                )
            self._validate_semantic_types(client, extractor)

            results = {
                query.id: self._execute(client, query)
                for query in extractor.queries
            }
            assembler = self._load_assembler(extractor)
            summary, findings = assembler(results)
            return ExtractionReport(
                extractor_id=extractor.id,
                extractor_version=extractor.version,
                data_source=extractor.data_source,
                identity_policy=extractor.identity_policy,
                semantic_types=extractor.semantic_types,
                database=str(client.db_path),
                generated_at=datetime.now(timezone.utc).isoformat(),
                summary=summary,
                findings=findings,
                query_results=results,
            )

    @staticmethod
    def _execute(client: LadybugClient, query: EvidenceQuery) -> QueryResult:
        assert_read_only_cypher(query.cypher)
        try:
            result = (
                client.conn.execute(query.cypher, parameters=dict(query.parameters))
                if query.parameters else client.conn.execute(query.cypher)
            )
        except Exception as error:
            raise RuntimeError(f"Evidence query {query.id!r} failed: {error}") from error
        columns = [str(column) for column in result.get_column_names()]
        rows: list[dict[str, Any]] = []
        while result.has_next():
            values = result.get_next()
            rows.append({columns[index]: values[index] for index in range(len(columns))})
        return QueryResult(
            query_id=query.id,
            description=query.description,
            category=query.category,
            columns=columns,
            rows=rows,
        )

    @staticmethod
    def _load_assembler(extractor: SemanticExtractor) -> Assembler:
        if not extractor.assembler_module:
            return _raw_assembler
        module = importlib.import_module(extractor.assembler_module)
        assembler = getattr(module, "assemble", None)
        if not callable(assembler):
            raise RuntimeError(
                f"{extractor.assembler_module} does not export assemble(results)"
            )
        return assembler

    @staticmethod
    def _validate_semantic_types(
        client: LadybugClient,
        extractor: SemanticExtractor,
    ) -> None:
        missing = []
        for role, binary_name in extractor.semantic_types.items():
            result = client.conn.execute(
                "MATCH (type:JvmClass) WHERE type.binaryName = $binaryName "
                "RETURN type.id LIMIT 1",
                parameters={"binaryName": binary_name},
            )
            if not result.has_next():
                missing.append(f"{role}={binary_name}")
        if missing:
            raise RuntimeError(
                "Extractor semantic types are absent from LadybugDB: " + ", ".join(missing)
            )


def _raw_assembler(results: Mapping[str, QueryResult]) -> tuple[dict[str, Any], dict[str, Any]]:
    counts = {query_id: len(result.rows) for query_id, result in results.items()}
    return (
        {"evidenceQueryCounts": counts},
        {"evidence": {key: value.rows for key, value in results.items()}},
    )


_REPOSITORY_SPECIFIC_LITERAL = re.compile(
    r"file://|/(?:Users|home)/|[A-Za-z]:\\|sample_projects|monorepo",
    re.IGNORECASE,
)
_FIXED_POSITION_COMPARISON = re.compile(
    r"\b(?:startLine|endLine|requestLine|startCharacter|endCharacter)\s*=\s*\d+\b",
    re.IGNORECASE,
)
_UNSTRUCTURED_IDENTITY_MATCH = re.compile(
    r"\b(?:hover\.contents|callee\.uri|targetUri)\s+CONTAINS\b",
    re.IGNORECASE,
)


def assert_portable_evidence_query(query: EvidenceQuery) -> None:
    """Reject evidence queries coupled to one repository or fixed source layout."""

    assert_read_only_cypher(query.cypher)
    if _REPOSITORY_SPECIFIC_LITERAL.search(query.cypher):
        raise ValueError(
            f"Evidence query {query.id!r} contains a repository-specific path or name"
        )
    if _FIXED_POSITION_COMPARISON.search(query.cypher):
        raise ValueError(
            f"Evidence query {query.id!r} contains a fixed source-position comparison"
        )
    if _UNSTRUCTURED_IDENTITY_MATCH.search(query.cypher):
        raise ValueError(
            f"Evidence query {query.id!r} matches semantic identity through unstructured text"
        )


def load_extractor(extractor_id: str) -> SemanticExtractor:
    """Load ``analyzer/extractors/<id>/manifest.json`` and its evidence queries."""

    if not extractor_id.replace("-", "_").isalnum():
        raise ValueError(f"Invalid extractor id: {extractor_id!r}")
    extractor_dir = Path(__file__).parent / extractor_id
    manifest_path = extractor_dir / "manifest.json"
    if not manifest_path.is_file():
        available = sorted(
            path.parent.name for path in Path(__file__).parent.glob("*/manifest.json")
        )
        raise FileNotFoundError(
            f"Unknown semantic extractor {extractor_id!r}; available: {available}"
        )

    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest.get("id") != extractor_id:
        raise ValueError(
            f"Extractor manifest id {manifest.get('id')!r} does not match folder "
            f"{extractor_id!r}"
        )
    if manifest.get("schemaVersion") != 1:
        raise ValueError(
            f"Extractor {extractor_id!r} uses unsupported schemaVersion "
            f"{manifest.get('schemaVersion')!r}; expected 1"
        )
    if manifest.get("dataSource") != "ladybugdb-only":
        raise ValueError(
            f"Extractor {extractor_id!r} must declare dataSource='ladybugdb-only'"
        )
    if manifest.get("identityPolicy") != "framework-semantic-identities":
        raise ValueError(
            f"Extractor {extractor_id!r} must use framework semantic identities"
        )
    semantic_types = manifest.get("semanticTypes")
    if not isinstance(semantic_types, dict) or not semantic_types:
        raise ValueError(f"Extractor {extractor_id!r} must declare semanticTypes")
    if not all(isinstance(role, str) and isinstance(name, str) for role, name in semantic_types.items()):
        raise ValueError(f"Extractor {extractor_id!r} has invalid semanticTypes")
    queries = []
    query_ids: set[str] = set()
    for entry in manifest["queries"]:
        if entry["id"] in query_ids:
            raise ValueError(
                f"Extractor {extractor_id!r} repeats query id {entry['id']!r}"
            )
        query_ids.add(entry["id"])
        query_path = (extractor_dir / entry["file"]).resolve()
        if extractor_dir.resolve() not in query_path.parents:
            raise ValueError(
                f"Evidence query escapes its extractor directory: {entry['file']!r}"
            )
        if not query_path.is_file():
            raise FileNotFoundError(f"Evidence query does not exist: {query_path}")
        query = EvidenceQuery(
            id=entry["id"],
            description=entry["description"],
            category=entry["category"],
            cypher=query_path.read_text(encoding="utf-8").strip(),
            parameters=_resolve_query_parameters(
                entry.get("parameters", {}), semantic_types, extractor_id
            ),
        )
        assert_portable_evidence_query(query)
        queries.append(query)
    return SemanticExtractor(
        id=manifest["id"],
        version=manifest["version"],
        description=manifest["description"],
        data_source=manifest["dataSource"],
        identity_policy=manifest["identityPolicy"],
        semantic_types=semantic_types,
        required_tables=tuple(manifest.get("requiredTables", [])),
        queries=tuple(queries),
        assembler_module=manifest.get("assemblerModule"),
    )


def _resolve_query_parameters(
    parameters: Mapping[str, Any],
    semantic_types: Mapping[str, str],
    extractor_id: str,
) -> dict[str, Any]:
    resolved: dict[str, Any] = {}
    for name, value in parameters.items():
        if isinstance(value, dict) and set(value) == {"semanticType"}:
            role = value["semanticType"]
            if role not in semantic_types:
                raise ValueError(
                    f"Extractor {extractor_id!r} query parameter {name!r} references "
                    f"unknown semantic type {role!r}"
                )
            resolved[name] = semantic_types[role]
        else:
            resolved[name] = value
    return resolved
