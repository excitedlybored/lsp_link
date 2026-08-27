"""Contract tests for portable, LadybugDB-only semantic extractors."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import ladybug

from analyzer.extractors.core import (
    EvidenceQuery,
    ExtractionPipeline,
    assert_portable_evidence_query,
    load_extractor,
)


class ExtractorPolicyTest(unittest.TestCase):
    def test_temporal_extractor_declares_portable_ladybugdb_policy(self) -> None:
        extractor = load_extractor("temporal")

        self.assertEqual(extractor.data_source, "ladybugdb-only")
        self.assertEqual(
            extractor.identity_policy,
            "framework-semantic-identities",
        )
        self.assertGreater(len(extractor.queries), 0)
        self.assertEqual(
            extractor.semantic_types["workflowEntryPoint"],
            "io.temporal.workflow.WorkflowMethod",
        )
        self.assertFalse(
            any(query.id.endswith("name_candidates") for query in extractor.queries)
        )
        self.assertEqual(extractor.applicability_semantic_types, ("workflowContract",))
        self.assertIn("JvmClassResolution", extractor.required_tables)
        self.assertIn("LspCoverage", extractor.completeness_tables)
        self.assertEqual(
            set(extractor.coverage_capabilities),
            {
                "textDocument/documentSymbol",
                "textDocument/hover",
                "textDocument/implementation",
                "callHierarchy/outgoingCalls",
                "callHierarchy/incomingCalls",
            },
        )

    def test_rejects_repository_specific_paths(self) -> None:
        query = EvidenceQuery(
            id="fixture_path",
            description="invalid fixture-specific query",
            category="test",
            cypher="MATCH (s:LspMethodSymbol) WHERE s.uri CONTAINS '/Users/me/repo' RETURN s",
        )

        with self.assertRaisesRegex(ValueError, "repository-specific"):
            assert_portable_evidence_query(query)

    def test_rejects_fixed_source_positions(self) -> None:
        query = EvidenceQuery(
            id="fixed_line",
            description="invalid position-specific query",
            category="test",
            cypher="MATCH (s:LspMethodSymbol) WHERE s.startLine = 42 RETURN s",
        )

        with self.assertRaisesRegex(ValueError, "fixed source-position"):
            assert_portable_evidence_query(query)

    def test_rejects_semantic_identity_from_hover_or_uri_text(self) -> None:
        query = EvidenceQuery(
            id="hover_identity",
            description="invalid unstructured identity matching",
            category="test",
            cypher=(
                "MATCH (hover:LspHover) "
                "WHERE hover.contents CONTAINS 'framework.Annotation' RETURN hover"
            ),
        )

        with self.assertRaisesRegex(ValueError, "unstructured text"):
            assert_portable_evidence_query(query)


def _analysis_run(
    run_id: str = "run-current",
    *,
    status: str = "complete",
    completed_at: str = "2026-08-27T10:00:00Z",
    error_count: int = 0,
    timeout_count: int = 0,
) -> SimpleNamespace:
    return SimpleNamespace(
        id=run_id,
        status=status,
        error_count=error_count,
        timeout_count=timeout_count,
        started_at="2026-08-27T09:00:00Z",
        completed_at=completed_at,
    )


def _artifact_run(
    run_id: str = "run-current",
    *,
    status: str = "complete",
    truncated: bool = False,
    error_count: int = 0,
    classpath_error_count: int = 0,
) -> SimpleNamespace:
    return SimpleNamespace(
        id=f"artifact-{run_id}",
        lsp_run_id=run_id,
        status=status,
        provider="asm",
        artifact_count=2,
        class_count=100,
        classpath_error_count=classpath_error_count,
        error_count=error_count,
        truncated=truncated,
        completed_at="2026-08-27T10:00:00Z",
    )


def _coverage(capability: str, *, run_id: str = "run-current", **overrides: object) -> SimpleNamespace:
    values = {
        "run_id": run_id,
        "capability": capability,
        "status": "mapped",
        "eligible_count": 10,
        "attempted_count": 10,
        "success_count": 10,
        "failure_count": 0,
        "timeout_count": 0,
        "result_count": 10,
        "mapped_count": 10,
        "unmapped_count": 0,
    }
    values.update(overrides)
    return SimpleNamespace(**values)


class _HealthClient:
    def __init__(
        self,
        extractor: object,
        *,
        analysis_runs: list[SimpleNamespace] | None = None,
        roots: list[SimpleNamespace] | None = None,
        artifact_runs: list[SimpleNamespace] | None = None,
        coverage: list[SimpleNamespace] | None = None,
        tables: set[str] | None = None,
    ) -> None:
        self.tables = {
            name: "NODE"
            for name in (tables if tables is not None else {
                "LspAnalysisRun", "LspBuildRoot", "JvmArtifactEnrichmentRun", "LspCoverage"
            })
        }
        self.schema = "lsp-native"
        self.db_path = Path("/tmp/test.lbug")
        self._analysis_runs = analysis_runs if analysis_runs is not None else [_analysis_run()]
        self._roots = roots if roots is not None else [SimpleNamespace(
            id="root", run_id="run-current", relative_path=".",
            build_systems=["bazel"], import_status="ready",
        )]
        self._artifact_runs = artifact_runs if artifact_runs is not None else [_artifact_run()]
        self._coverage = coverage if coverage is not None else [
            _coverage(capability) for capability in extractor.coverage_capabilities
        ]

    def get_lsp_analysis_runs(self) -> list[SimpleNamespace]:
        return self._analysis_runs

    def get_lsp_build_roots(self) -> list[SimpleNamespace]:
        return self._roots

    def get_jvm_enrichment_runs(self) -> list[SimpleNamespace]:
        return self._artifact_runs

    def get_lsp_coverage(self) -> list[SimpleNamespace]:
        return self._coverage

    def __enter__(self) -> "_HealthClient":
        return self

    def __exit__(self, *_: object) -> None:
        return None


class IndexQualificationTest(unittest.TestCase):
    def setUp(self) -> None:
        self.extractor = load_extractor("temporal")

    def assess(self, client: _HealthClient, present: set[str]) -> dict[str, object]:
        return ExtractionPipeline._assess_index_health(client, self.extractor, present)

    def test_partial_reports_truncation_failed_bazel_and_unmapped_coverage(self) -> None:
        coverage = [_coverage(capability) for capability in self.extractor.coverage_capabilities]
        coverage[1] = _coverage(
            self.extractor.coverage_capabilities[1],
            status="unmapped",
            mapped_count=8,
            unmapped_count=2,
        )
        client = _HealthClient(
            self.extractor,
            analysis_runs=[_analysis_run(status="partial", error_count=2, timeout_count=1)],
            roots=[SimpleNamespace(
                id="failed-root", run_id="run-current", relative_path="service",
                build_systems=["Bazel"], import_status="failed",
            )],
            artifact_runs=[_artifact_run(
                status="partial", truncated=True, error_count=3, classpath_error_count=4,
            )],
            coverage=coverage,
        )

        health = self.assess(client, {"workflowContract"})

        self.assertEqual(health["qualification"], "partial")
        self.assertEqual(health["analysisRuns"][0]["errorCount"], 2)
        self.assertEqual(health["bazel"]["failedRoots"][0]["id"], "failed-root")
        self.assertTrue(health["artifactEnrichment"]["truncated"])
        self.assertEqual(health["artifactEnrichment"]["errorCount"], 3)
        self.assertEqual(health["artifactEnrichment"]["classpathErrorCount"], 4)
        self.assertEqual(health["lspCoverage"]["unmappedCount"], 2)

    def test_latest_analysis_run_scopes_roots_enrichment_and_coverage(self) -> None:
        current_coverage = [
            _coverage(capability) for capability in self.extractor.coverage_capabilities
        ]
        old_coverage = [
            _coverage(capability, run_id="run-old", status="failed", failure_count=1)
            for capability in self.extractor.coverage_capabilities
        ]
        client = _HealthClient(
            self.extractor,
            analysis_runs=[
                _analysis_run("run-old", status="failed", completed_at="2026-08-26T10:00:00Z"),
                _analysis_run(),
            ],
            roots=[
                SimpleNamespace(id="old", run_id="run-old", relative_path="old", build_systems=["bazel"], import_status="failed"),
                SimpleNamespace(id="current", run_id="run-current", relative_path=".", build_systems=["bazel"], import_status="ready"),
            ],
            artifact_runs=[_artifact_run("run-old", status="failed"), _artifact_run()],
            coverage=old_coverage + current_coverage,
        )

        health = self.assess(client, {"workflowContract"})

        self.assertEqual(health["qualification"], "complete")
        self.assertEqual(health["selectedAnalysisRunId"], "run-current")
        self.assertEqual(health["analysisRunCount"], 2)
        self.assertEqual(health["bazel"]["failedRoots"], [])

    def test_absent_framework_anchor_is_not_applicable_only_when_health_is_complete(self) -> None:
        health = self.assess(_HealthClient(self.extractor), set())

        self.assertEqual(health["qualification"], "not_applicable")
        self.assertEqual(
            health["applicability"]["missingAnchorSemanticTypes"],
            ["workflowContract"],
        )

        partial = self.assess(
            _HealthClient(self.extractor, artifact_runs=[_artifact_run(status="partial")]),
            set(),
        )
        self.assertEqual(partial["qualification"], "partial")

    def test_missing_health_signal_is_reported_as_partial_not_an_exception(self) -> None:
        client = _HealthClient(
            self.extractor,
            tables={"LspAnalysisRun", "LspBuildRoot", "JvmArtifactEnrichmentRun"},
        )

        health = self.assess(client, {"workflowContract"})

        self.assertEqual(health["qualification"], "partial")
        self.assertFalse(health["lspCoverage"]["available"])
        self.assertIn(
            "completeness_signal_unavailable",
            {item["code"] for item in health["limitations"]},
        )

    def test_only_mapped_and_successful_empty_coverage_are_complete(self) -> None:
        for status in ("unsupported", "excluded", "observed", "unmapped", "partial", "failed", "timeout"):
            with self.subTest(status=status):
                coverage = [
                    _coverage(capability) for capability in self.extractor.coverage_capabilities
                ]
                coverage[0] = _coverage(
                    self.extractor.coverage_capabilities[0], status=status
                )
                health = self.assess(
                    _HealthClient(self.extractor, coverage=coverage),
                    {"workflowContract"},
                )
                self.assertEqual(health["qualification"], "partial")

        coverage = [
            _coverage(capability) for capability in self.extractor.coverage_capabilities
        ]
        coverage[0] = _coverage(
            self.extractor.coverage_capabilities[0],
            status="empty",
            result_count=0,
            mapped_count=0,
        )
        health = self.assess(
            _HealthClient(self.extractor, coverage=coverage),
            {"workflowContract"},
        )
        self.assertEqual(health["qualification"], "complete")

    def test_pipeline_emits_not_applicable_report_without_running_evidence_queries(self) -> None:
        client = _HealthClient(self.extractor)
        client.tables.update({table: "NODE" for table in self.extractor.required_tables})
        with (
            patch("analyzer.extractors.core.LadybugClient", return_value=client),
            patch.object(ExtractionPipeline, "_semantic_types_present", return_value=set()),
            patch.object(ExtractionPipeline, "_execute") as execute,
        ):
            report = ExtractionPipeline("/tmp/test.lbug").run(self.extractor)

        execute.assert_not_called()
        payload = report.to_dict(include_raw=True)
        self.assertEqual(payload["qualification"], "not_applicable")
        self.assertEqual(payload["findings"], {})
        self.assertEqual(payload["evidenceQueryResults"], {})
        self.assertIn("indexHealth", payload)

    def test_missing_class_resolution_fails_instead_of_falling_back(self) -> None:
        client = _HealthClient(self.extractor)
        client.tables.update({table: "NODE" for table in self.extractor.required_tables})
        del client.tables["JvmClassResolution"]
        with patch("analyzer.extractors.core.LadybugClient", return_value=client):
            with self.assertRaisesRegex(
                RuntimeError,
                r"requires missing tables: \['JvmClassResolution'\]",
            ):
                ExtractionPipeline("/tmp/test.lbug").run(self.extractor)


class CanonicalClassResolutionTest(unittest.TestCase):
    def test_semantic_validation_and_sdk_discovery_ignore_losing_duplicates(self) -> None:
        extractor = load_extractor("temporal")
        with tempfile.TemporaryDirectory() as directory:
            database = ladybug.Database(str(Path(directory) / "canonical.lbug"))
            connection = ladybug.Connection(database)
            try:
                connection.execute(
                    "CREATE NODE TABLE JvmClassResolution("
                    "binaryName STRING, classId STRING, artifactId STRING, "
                    "PRIMARY KEY(binaryName))"
                )
                connection.execute(
                    "CREATE NODE TABLE JvmClass("
                    "id STRING, artifactId STRING, binaryName STRING, kind STRING, "
                    "superName STRING, interfaces STRING[], sourceEntry STRING, "
                    "PRIMARY KEY(id))"
                )

                classes = [
                    ("contract-winning", "temporal-winning", "io.temporal.workflow.WorkflowInterface"),
                    ("contract-losing", "temporal-losing", "io.temporal.workflow.WorkflowInterface"),
                    ("client-winning", "temporal-winning", "io.temporal.client.WorkflowClient"),
                    ("client-losing", "temporal-losing", "io.temporal.client.WorkflowClient"),
                    ("losing-only", "temporal-losing", "io.temporal.worker.WorkerFactory"),
                    ("co-located", "temporal-winning", "com.vendor.ShadedHelper"),
                ]
                for class_id, artifact_id, binary_name in classes:
                    connection.execute(
                        "CREATE (class:JvmClass {"
                        "id:$id, artifactId:$artifactId, binaryName:$binaryName, "
                        "kind:'class', superName:'java.lang.Object', interfaces:[], "
                        "sourceEntry:''})",
                        parameters={
                            "id": class_id,
                            "artifactId": artifact_id,
                            "binaryName": binary_name,
                        },
                    )

                resolutions = [
                    ("io.temporal.workflow.WorkflowInterface", "contract-winning", "temporal-winning"),
                    ("io.temporal.client.WorkflowClient", "client-winning", "temporal-winning"),
                    ("io.temporal.worker.WorkerFactory", "losing-only", "temporal-losing"),
                    ("com.vendor.ShadedHelper", "co-located", "temporal-winning"),
                ]
                for binary_name, class_id, artifact_id in resolutions:
                    connection.execute(
                        "CREATE (resolution:JvmClassResolution {"
                        "binaryName:$binaryName, classId:$classId, artifactId:$artifactId})",
                        parameters={
                            "binaryName": binary_name,
                            "classId": class_id,
                            "artifactId": artifact_id,
                        },
                    )

                present = ExtractionPipeline._semantic_types_present(
                    SimpleNamespace(conn=connection), extractor
                )
                self.assertIn("workflowContract", present)
                self.assertIn("workflowClient", present)

                sdk_query = next(query for query in extractor.queries if query.id == "sdk_classes")
                result = connection.execute(
                    sdk_query.cypher, parameters=dict(sdk_query.parameters)
                )
                columns = [str(column) for column in result.get_column_names()]
                rows = []
                while result.has_next():
                    values = result.get_next()
                    rows.append(dict(zip(columns, values)))

                self.assertEqual(
                    [row["classId"] for row in rows],
                    ["client-winning", "losing-only", "contract-winning"],
                )
                self.assertNotIn("client-losing", {row["classId"] for row in rows})
                self.assertNotIn("co-located", {row["classId"] for row in rows})
            finally:
                connection.close()
                database.close()


if __name__ == "__main__":
    unittest.main()
