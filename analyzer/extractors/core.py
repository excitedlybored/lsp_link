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
    projections: tuple[str, ...] = ("legacy", "compact")


@dataclass(frozen=True)
class SemanticExtractor:
    id: str
    version: str
    description: str
    data_source: str
    identity_policy: str
    semantic_types: Mapping[str, str]
    required_tables: tuple[str, ...]
    applicability_semantic_types: tuple[str, ...]
    completeness_tables: tuple[str, ...]
    coverage_capabilities: tuple[str, ...]
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
    qualification: str
    index_health: dict[str, Any]
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
            "qualification": self.qualification,
            "indexHealth": self.index_health,
            "summary": self.summary,
            "findings": self.findings,
        }
        if include_raw:
            payload["evidenceQueryResults"] = {
                key: asdict(result) for key, result in self.query_results.items()
            }
        return payload


Assembler = Callable[[Mapping[str, QueryResult]], tuple[dict[str, Any], dict[str, Any]]]


def _limitation(code: str, message: str) -> dict[str, str]:
    return {"code": code, "message": message}


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
            present_semantic_types = self._semantic_types_present(client, extractor)
            index_health = self._assess_index_health(
                client, extractor, present_semantic_types
            )

            if index_health["qualification"] == "not_applicable":
                results: dict[str, QueryResult] = {}
                summary = {
                    "evidenceQueryCounts": {},
                    "notApplicableReason": index_health["applicability"]["reason"],
                }
                findings: dict[str, Any] = {}
            else:
                artifact_runs = client.get_jvm_enrichment_runs()
                projection = next((
                    getattr(run, "projection", "compact" if run.provider == "sootup" else "legacy")
                    for run in artifact_runs if not index_health.get("analysisRuns")
                    or run.lsp_run_id == index_health["analysisRuns"][0]["id"]
                ), "legacy")
                results = {
                    query.id: self._execute(client, query)
                    for query in extractor.queries if projection in query.projections
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
                qualification=index_health["qualification"],
                index_health=index_health,
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
    def _semantic_types_present(
        client: LadybugClient,
        extractor: SemanticExtractor,
    ) -> set[str]:
        present: set[str] = set()
        for role, binary_name in extractor.semantic_types.items():
            result = client.conn.execute(
                "MATCH (resolution:JvmClassResolution), (type:JvmClass) "
                "WHERE resolution.binaryName = $binaryName "
                "AND type.id = resolution.classId "
                "AND type.artifactId = resolution.artifactId "
                "RETURN type.id LIMIT 1",
                parameters={"binaryName": binary_name},
            )
            if result.has_next():
                present.add(role)
                continue
            result = client.conn.execute(
                "MATCH (type:JvmClass) WHERE type.binaryName = $binaryName "
                "RETURN type.id LIMIT 1",
                parameters={"binaryName": binary_name},
            )
            if result.has_next():
                present.add(role)
                continue
            try:
                result = client.conn.execute(
                    "MATCH (type:JvmClass) "
                    "WHERE list_contains(type.annotations, $binaryName) "
                    "RETURN type.id LIMIT 1",
                    parameters={"binaryName": binary_name},
                )
                if result.has_next():
                    present.add(role)
                    continue
                result = client.conn.execute(
                    "MATCH (method:JvmMethod) "
                    "WHERE list_contains(method.annotations, $binaryName) "
                    "RETURN method.id LIMIT 1",
                    parameters={"binaryName": binary_name},
                )
                if result.has_next():
                    present.add(role)
            except RuntimeError:
                # Legacy databases can predate the structured annotation columns.
                continue
        return present

    @staticmethod
    def _assess_index_health(
        client: LadybugClient,
        extractor: SemanticExtractor,
        present_semantic_types: set[str],
    ) -> dict[str, Any]:
        limitations: list[dict[str, str]] = []

        all_analysis_runs = (
            client.get_lsp_analysis_runs() if "LspAnalysisRun" in client.tables else []
        )
        selected_analysis_run = max(
            all_analysis_runs,
            key=lambda run: (run.completed_at or run.started_at or "", run.started_at or "", run.id),
            default=None,
        )
        selected_run_id = selected_analysis_run.id if selected_analysis_run else None
        analysis_runs = [
            {
                "id": run.id,
                "status": run.status,
                "errorCount": run.error_count,
                "timeoutCount": run.timeout_count,
                "completedAt": run.completed_at,
            }
            for run in ([selected_analysis_run] if selected_analysis_run else [])
        ]
        if not analysis_runs:
            limitations.append(_limitation("analysis_run_unavailable", "No analysis-run health was persisted."))
        for run in analysis_runs:
            if run["status"] != "complete" or run["errorCount"] or run["timeoutCount"]:
                limitations.append(_limitation(
                    "analysis_run_incomplete",
                    f"Analysis run {run['id']} is {run['status']} with "
                    f"{run['errorCount']} errors and {run['timeoutCount']} timeouts.",
                ))

        all_roots = client.get_lsp_build_roots() if "LspBuildRoot" in client.tables else []
        roots = [
            root for root in all_roots
            if selected_run_id is None or root.run_id == selected_run_id
        ]
        bazel_roots = [root for root in roots if "bazel" in {value.lower() for value in root.build_systems}]
        failed_bazel_roots = [
            {
                "id": root.id,
                "relativePath": root.relative_path,
                "importStatus": root.import_status,
            }
            for root in bazel_roots
            if root.import_status == "failed"
        ]
        incomplete_bazel_roots = [root for root in bazel_roots if root.import_status != "ready"]
        if incomplete_bazel_roots:
            limitations.append(_limitation(
                "bazel_roots_incomplete",
                f"{len(incomplete_bazel_roots)} Bazel root(s) were not ready.",
            ))

        matching_artifact_runs = [
            run for run in client.get_jvm_enrichment_runs()
            if selected_run_id is None or run.lsp_run_id == selected_run_id
        ]
        artifact_runs = [
            {
                "id": run.id,
                "status": run.status,
                "provider": run.provider,
                "graphSchemaVersion": getattr(run, "graph_schema_version", 1),
                "projection": getattr(run, "projection", "legacy"),
                "artifactCount": run.artifact_count,
                "classCount": run.class_count,
                "classpathErrorCount": run.classpath_error_count,
                "errorCount": run.error_count,
                "truncated": run.truncated,
                "completedAt": run.completed_at,
            }
            for run in matching_artifact_runs
        ]
        if not artifact_runs:
            limitations.append(_limitation(
                "artifact_enrichment_unavailable",
                "No artifact-enrichment health was persisted.",
            ))
        for run in artifact_runs:
            if (
                run["status"] != "complete"
                or run["truncated"]
                or run["errorCount"]
                or run["classpathErrorCount"]
            ):
                limitations.append(_limitation(
                    "artifact_enrichment_incomplete",
                    f"Artifact enrichment {run['id']} is {run['status']} "
                    f"(truncated={str(run['truncated']).lower()}, errors={run['errorCount']}, "
                    f"classpathErrors={run['classpathErrorCount']}).",
                ))

        coverage_available = "LspCoverage" in client.tables
        coverage_rows = client.get_lsp_coverage() if coverage_available else []
        coverage_rows = [
            row for row in coverage_rows
            if selected_run_id is None or row.run_id == selected_run_id
        ]
        relevant_coverage: list[dict[str, Any]] = []
        coverage_by_capability: dict[str, list[Any]] = {}
        for coverage in coverage_rows:
            coverage_by_capability.setdefault(coverage.capability, []).append(coverage)
        complete_coverage_statuses = {"mapped", "empty"}
        for capability in extractor.coverage_capabilities:
            rows = coverage_by_capability.get(capability, [])
            item = {
                "capability": capability,
                "available": bool(rows),
                "statuses": sorted({row.status for row in rows}),
                "eligibleCount": sum(row.eligible_count for row in rows),
                "attemptedCount": sum(row.attempted_count for row in rows),
                "successCount": sum(row.success_count for row in rows),
                "failureCount": sum(row.failure_count for row in rows),
                "timeoutCount": sum(row.timeout_count for row in rows),
                "resultCount": sum(row.result_count for row in rows),
                "mappedCount": sum(row.mapped_count for row in rows),
                "unmappedCount": sum(row.unmapped_count for row in rows),
            }
            relevant_coverage.append(item)
            if not rows:
                limitations.append(_limitation(
                    "lsp_coverage_missing",
                    f"Relevant LSP capability {capability} has no coverage record.",
                ))
            elif (
                not set(item["statuses"]).issubset(complete_coverage_statuses)
                or item["failureCount"]
                or item["timeoutCount"]
                or item["unmappedCount"]
            ):
                limitations.append(_limitation(
                    "lsp_coverage_incomplete",
                    f"Relevant LSP capability {capability} has incomplete or unmapped coverage.",
                ))

        missing_completeness_tables = [
            table for table in extractor.completeness_tables if table not in client.tables
        ]
        for table in missing_completeness_tables:
            limitations.append(_limitation(
                "completeness_signal_unavailable",
                f"Completeness table {table} is unavailable in this schema.",
            ))

        missing_semantic_types = [
            role for role in extractor.semantic_types if role not in present_semantic_types
        ]
        absent_applicability_types = [
            role for role in extractor.applicability_semantic_types
            if role not in present_semantic_types
        ]
        applicability_absent = bool(extractor.applicability_semantic_types) and (
            len(absent_applicability_types) == len(extractor.applicability_semantic_types)
        )
        if limitations:
            qualification = "partial"
            applicability_reason = (
                "Framework anchor types were not observed, but index limitations prevent "
                "a reliable not-applicable conclusion."
                if applicability_absent else "Framework evidence may be incomplete."
            )
        elif applicability_absent:
            qualification = "not_applicable"
            applicability_reason = "None of the extractor's framework anchor types are present."
        else:
            qualification = "complete"
            applicability_reason = "At least one framework anchor type is present."

        return {
            "qualification": qualification,
            "selectedAnalysisRunId": selected_run_id,
            "analysisRunCount": len(all_analysis_runs),
            "analysisRuns": analysis_runs,
            "bazel": {
                "rootCount": len(bazel_roots),
                "failedRoots": failed_bazel_roots,
                "incompleteRootCount": len(incomplete_bazel_roots),
            },
            "artifactEnrichment": {
                "available": bool(artifact_runs),
                "runs": artifact_runs,
                "errorCount": sum(run["errorCount"] for run in artifact_runs),
                "classpathErrorCount": sum(run["classpathErrorCount"] for run in artifact_runs),
                "truncated": any(run["truncated"] for run in artifact_runs),
            },
            "lspCoverage": {
                "available": coverage_available,
                "relevantCapabilities": relevant_coverage,
                "failureCount": sum(item["failureCount"] for item in relevant_coverage),
                "timeoutCount": sum(item["timeoutCount"] for item in relevant_coverage),
                "unmappedCount": sum(item["unmappedCount"] for item in relevant_coverage),
            },
            "applicability": {
                "anchorSemanticTypes": list(extractor.applicability_semantic_types),
                "missingAnchorSemanticTypes": absent_applicability_types,
                "missingSemanticTypes": missing_semantic_types,
                "reason": applicability_reason,
            },
            "limitations": limitations,
        }


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
    completeness = manifest.get("completenessRequirements", {})
    if not isinstance(completeness, dict):
        raise ValueError(
            f"Extractor {extractor_id!r} has invalid completenessRequirements"
        )
    applicability_types = tuple(manifest.get("applicabilitySemanticTypes", ()))
    unknown_applicability_types = [
        role for role in applicability_types if role not in semantic_types
    ]
    if unknown_applicability_types:
        raise ValueError(
            f"Extractor {extractor_id!r} has unknown applicability semantic types: "
            f"{unknown_applicability_types}"
        )
    completeness_tables = tuple(completeness.get("tables", ()))
    coverage_capabilities = tuple(completeness.get("lspCapabilities", ()))
    if not all(isinstance(value, str) for value in (*completeness_tables, *coverage_capabilities)):
        raise ValueError(
            f"Extractor {extractor_id!r} has invalid completeness requirements"
        )
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
            projections=tuple(entry.get("projections", ("legacy", "compact"))),
        )
        if not query.projections or not set(query.projections).issubset({"legacy", "compact"}):
            raise ValueError(f"Evidence query {query.id!r} has invalid projections")
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
        applicability_semantic_types=applicability_types,
        completeness_tables=completeness_tables,
        coverage_capabilities=coverage_capabilities,
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
