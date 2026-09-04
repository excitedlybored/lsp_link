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
    QueryResult,
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
            {"textDocument/documentSymbol"},
        )
        self.assertIn("jvm_workflow_contracts", {query.id for query in extractor.queries})
        self.assertIn("jvm_temporal_sdk_calls", {query.id for query in extractor.queries})

    def test_kafka_extractor_is_portable_and_supports_both_jvm_schemas(self) -> None:
        extractor = load_extractor("kafka")
        query_ids = {query.id for query in extractor.queries}
        self.assertEqual(extractor.data_source, "ladybugdb-only")
        self.assertEqual(extractor.applicability_semantic_types, ("producer", "listener"))
        self.assertIn("legacy_producers", query_ids)
        self.assertIn("compact_producers", query_ids)
        self.assertIn("configuration_candidates", query_ids)
        self.assertEqual(
            next(query for query in extractor.queries if query.id == "legacy_producers").projections,
            ("legacy",),
        )
        self.assertEqual(
            next(query for query in extractor.queries if query.id == "compact_producers").projections,
            ("compact",),
        )

    def test_kafka_assembler_preserves_topic_candidates_and_evidence(self) -> None:
        from analyzer.extractors.kafka.assembler import assemble

        result = lambda name, rows: QueryResult(name, name, "test", [], rows)
        summary, findings = assemble({
            "compact_producers": result("compact_producers", [{
                "evidenceId": "call", "ownerId": "owner", "packageName": "example",
                "ownerName": "PublishingActivityImpl", "methodId": "method",
                "methodName": "publish", "descriptor": "(Ljava/lang/String;)V",
                "confidence": 0.9,
            }]),
            "listeners": result("listeners", [{
                "evidenceId": "listener", "ownerId": "listener-owner", "packageName": "example",
                "ownerName": "TopicListener", "methodId": "listener-method", "methodName": "receive",
                "descriptor": "(Ljava/lang/String;)V", "confidence": 1.0,
                "annotationValuesJson": '{"listener":"${messaging.topic}"}',
            }]),
            "configuration_candidates": result("configuration_candidates", [{
                "evidenceId": "config", "key": "messaging.topic",
                "rawValue": "${TOPIC_NAME:neutral.events}", "resolvedValue": "neutral.events",
                "status": "symbolic", "confidence": 0.65,
            }]),
        })
        self.assertEqual(summary["producerCount"], 1)
        self.assertEqual(findings["topics"][0]["name"], "neutral.events")
        self.assertEqual(set(findings["topics"][0]["evidenceIds"]), {"listener", "config"})
        self.assertEqual(
            {edge["kind"] for edge in findings["graph"]["edges"]},
            {"PUBLISHES_TO", "CONSUMED_BY"},
        )

    def test_semantic_parity_normalization_ignores_provider_specific_ids(self) -> None:
        from analyzer.extractors.parity import normalized_semantics

        def report(prefix: str) -> SimpleNamespace:
            return SimpleNamespace(extractor_id="kafka", findings={"graph": {
                "nodes": [
                    {"id": f"{prefix}-producer", "kind": "producer", "label": "publish",
                     "semanticKey": "java:type:example.Activity#method:publish()V"},
                    {"id": f"{prefix}-topic", "kind": "kafka_topic", "label": "neutral.events"},
                ],
                "edges": [{"id": f"{prefix}-edge", "kind": "PUBLISHES_TO",
                           "source": f"{prefix}-producer", "target": f"{prefix}-topic"}],
            }})

        self.assertEqual(normalized_semantics([report("asm")]), normalized_semantics([report("sootup")]))

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
        coverage[0] = _coverage(
            self.extractor.coverage_capabilities[0],
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


class TemporalJvmEvidenceTest(unittest.TestCase):
    def test_core_jvm_evidence_queries_and_assembler(self) -> None:
        extractor = load_extractor("temporal")
        with tempfile.TemporaryDirectory() as directory:
            database = ladybug.Database(str(Path(directory) / "temporal-jvm.lbug"))
            connection = ladybug.Connection(database)
            try:
                self._create_schema(connection)
                self._create_fixture(connection)
                results = {}
                client = SimpleNamespace(conn=connection)
                for query in extractor.queries:
                    if query.id == "sdk_classes" or query.id.startswith("jvm_"):
                        results[query.id] = ExtractionPipeline._execute(client, query)

                self.assertEqual(len(results["jvm_workflow_contracts"].rows), 1)
                self.assertEqual(len(results["jvm_activity_contracts"].rows), 1)
                self.assertEqual(len(results["jvm_annotated_methods"].rows), 3)
                self.assertEqual(len(results["jvm_implementations"].rows), 2)
                self.assertEqual(len(results["jvm_method_implementations"].rows), 2)
                self.assertEqual(len(results["jvm_resolved_calls"].rows), 3)
                self.assertEqual(len(results["jvm_temporal_sdk_calls"].rows), 2)

                from analyzer.extractors.temporal.assembler import assemble

                summary, findings = assemble(results)
                self.assertEqual(summary["workflowCount"], 1)
                self.assertEqual(summary["activityContractCount"], 1)
                self.assertEqual(summary["workflowImplementationCount"], 1)
                self.assertEqual(summary["activityImplementationCount"], 1)
                self.assertEqual(summary["activityInvocationCount"], 1)
                self.assertEqual(summary["temporalRuntimeCallCount"], 2)
                self.assertEqual(
                    {call["operation"] for call in findings["runtimeCalls"]},
                    {"create_activity_stub", "signal"},
                )
                self.assertEqual(
                    {call["classification"] for call in
                     findings["workflows"][0]["implementations"][0]["calls"]},
                    {"activity", "temporal_sdk"},
                )
                graph = findings["graph"]
                self.assertEqual(graph["schemaVersion"], 1)
                self.assertEqual(graph["perspective"], "workflow")
                self.assertTrue(graph["directed"])
                self.assertEqual(len(graph["groups"]), 1)
                self.assertEqual(graph["groups"][0]["kind"], "workflow")
                self.assertEqual(
                    {
                        "HAS_ENTRYPOINT", "HAS_SIGNAL_HANDLER", "PROVIDES_ACTIVITY",
                        "INVOKES_ACTIVITY", "PREPARES_ACTIVITY", "SIGNALS",
                    },
                    set(graph["edgeKinds"]),
                )
                self.assertNotIn("workflow_implementation", graph["nodeKinds"])
                self.assertNotIn("activity_implementation", graph["nodeKinds"])
                code_evidence = graph["supportingEvidence"]
                self.assertEqual(code_evidence["perspective"], "java-evidence")
                self.assertIn("workflow_implementation", code_evidence["nodeKinds"])
                self.assertIn("IMPLEMENTS", code_evidence["edgeKinds"])
                self.assertGreater(len(code_evidence["bindings"]), 0)
                workflow_binding = next(
                    binding for binding in code_evidence["bindings"]
                    if binding["workflowNodeId"] == graph["groups"][0]["rootNodeId"]
                )
                self.assertEqual(workflow_binding["relationship"], "EVIDENCED_BY")
                self.assertEqual(len(workflow_binding["codeNodeIds"]), 2)
                self.assertEqual(
                    len(graph["nodes"]), len({node["id"] for node in graph["nodes"]})
                )
                self.assertEqual(
                    len(graph["edges"]), len({edge["id"] for edge in graph["edges"]})
                )
                signal_edge = next(
                    edge for edge in graph["edges"]
                    if edge["kind"] == "SIGNALS" and edge["label"] == "signals"
                )
                self.assertEqual(signal_edge["observationCount"], 1)
                self.assertEqual(signal_edge["observations"][0]["source"], "jvm-bytecode")
                self.assertEqual(signal_edge["observations"][0]["bytecodeOffset"], 13)
                self.assertEqual(summary["visualizationNodeCount"], len(graph["nodes"]))
                self.assertEqual(summary["visualizationEdgeCount"], len(graph["edges"]))
                self.assertEqual(summary["visualizationGroupCount"], len(graph["groups"]))
                self.assertEqual(
                    summary["visualizationCodeEvidenceNodeCount"],
                    len(code_evidence["nodes"]),
                )
                self.assertEqual(
                    summary["visualizationCodeBindingCount"],
                    len(code_evidence["bindings"]),
                )
                self.assertEqual(assemble(results)[1]["graph"], graph)

                workflow_row = results["jvm_workflow_contracts"].rows[0]
                method_row = next(
                    row for row in results["jvm_annotated_methods"].rows
                    if row["methodRole"] == "workflow"
                )
                implementation_row = next(
                    row for row in results["jvm_implementations"].rows
                    if row["contractId"] == workflow_row["contractId"]
                )
                results["workflow_contracts"] = QueryResult(
                    "workflow_contracts", "", "contract", [], [{
                        **workflow_row, "contractId": "lsp-workflow",
                        "evidenceId": "lsp-hover", "uri": "file:///OrderWorkflow.java",
                        "startLine": 4,
                    }]
                )
                results["annotated_methods"] = QueryResult(
                    "annotated_methods", "", "entrypoint", [], [{
                        **method_row, "ownerId": "lsp-workflow", "methodId": "lsp-run",
                        "evidenceId": "lsp-method-hover", "signature": "(): void",
                        "uri": "file:///OrderWorkflow.java", "startLine": 6,
                    }]
                )
                results["implementations"] = QueryResult(
                    "implementations", "", "implementation", [], [{
                        **implementation_row, "implementationId": "lsp-workflow-impl",
                        "contractId": "lsp-workflow", "evidenceId": "lsp-implementation",
                        "implementationUri": "file:///OrderWorkflowImpl.java",
                        "implementationStartLine": 3,
                    }]
                )
                merged_summary, merged_findings = assemble(results)
                self.assertEqual(merged_summary["workflowCount"], 1)
                self.assertEqual(merged_summary["workflowImplementationCount"], 1)
                self.assertEqual(
                    set(merged_findings["workflows"][0]["lbugNodeIds"]),
                    {"workflow", "lsp-workflow"},
                )
                self.assertEqual(
                    set(merged_findings["workflows"][0]["implementations"][0]["lbugNodeIds"]),
                    {"workflow-impl", "lsp-workflow-impl"},
                )
            finally:
                connection.close()
                database.close()

    @staticmethod
    def _create_schema(connection: object) -> None:
        statements = [
            "CREATE NODE TABLE JvmClassResolution(binaryName STRING, stageId STRING, "
            "classId STRING, artifactId STRING, classpathOrdinal INT32, PRIMARY KEY(binaryName))",
            "CREATE NODE TABLE JvmClass(id STRING, stageId STRING, artifactId STRING, "
            "binaryName STRING, packageName STRING, simpleName STRING, kind STRING, "
            "access STRING, superName STRING, interfaces STRING[], sourceEntry STRING, "
            "isSeed BOOLEAN, seedUris STRING[], wasDisassembled BOOLEAN, annotations STRING[], "
            "PRIMARY KEY(id))",
            "CREATE NODE TABLE JvmMethod(id STRING, stageId STRING, classId STRING, owner STRING, "
            "name STRING, descriptor STRING, declaration STRING, access STRING, hasCode BOOLEAN, "
            "isExternalPlaceholder BOOLEAN, annotations STRING[], PRIMARY KEY(id))",
            "CREATE NODE TABLE JvmCallSite(id STRING, stageId STRING, callerMethodId STRING, "
            "bytecodeOffset INT64, opcode STRING, targetOwner STRING, targetName STRING, "
            "targetDescriptor STRING, status STRING, PRIMARY KEY(id))",
            "CREATE REL TABLE JvmRelation(FROM JvmClass TO JvmClass, "
            "FROM JvmClass TO JvmMethod, FROM JvmMethod TO JvmCallSite, "
            "FROM JvmCallSite TO JvmMethod, id STRING, kind STRING, stageId STRING, "
            "status STRING, ordinal INT32)",
        ]
        for statement in statements:
            connection.execute(statement)

    @classmethod
    def _create_fixture(cls, connection: object) -> None:
        classes = [
            ("workflow", "app", "example.OrderWorkflow", "interface", ["io.temporal.workflow.WorkflowInterface"]),
            ("workflow-impl", "app", "example.OrderWorkflowImpl", "class", []),
            ("activity", "app", "example.OrderActivities", "interface", ["io.temporal.activity.ActivityInterface"]),
            ("activity-impl", "app", "example.OrderActivitiesImpl", "class", []),
            ("workflow-annotation", "temporal", "io.temporal.workflow.WorkflowInterface", "annotation", []),
            ("workflow-api", "temporal", "io.temporal.workflow.Workflow", "class", []),
        ]
        for class_id, artifact_id, binary_name, kind, annotations in classes:
            package_name, simple_name = binary_name.rsplit(".", 1)
            connection.execute(
                "CREATE (:JvmClass {id:$id, stageId:'stage', artifactId:$artifact, "
                "binaryName:$binary, packageName:$package, simpleName:$simple, kind:$kind, "
                "access:'public', superName:'java.lang.Object', interfaces:[], "
                "sourceEntry:$source, isSeed:false, seedUris:[], wasDisassembled:true, "
                "annotations:$annotations})",
                parameters={
                    "id": class_id, "artifact": artifact_id, "binary": binary_name,
                    "package": package_name, "simple": simple_name, "kind": kind,
                    "source": binary_name.replace(".", "/") + ".java",
                    "annotations": annotations,
                },
            )
            connection.execute(
                "CREATE (:JvmClassResolution {binaryName:$binary, stageId:'stage', "
                "classId:$id, artifactId:$artifact, classpathOrdinal:0})",
                parameters={"binary": binary_name, "id": class_id, "artifact": artifact_id},
            )

        methods = [
            ("workflow-run", "workflow", "example.OrderWorkflow", "run", "()V", ["io.temporal.workflow.WorkflowMethod"], False),
            ("workflow-cancel", "workflow", "example.OrderWorkflow", "cancel", "()V", ["io.temporal.workflow.SignalMethod"], False),
            ("workflow-impl-run", "workflow-impl", "example.OrderWorkflowImpl", "run", "()V", [], True),
            ("activity-charge", "activity", "example.OrderActivities", "charge", "()V", [], False),
            ("activity-impl-charge", "activity-impl", "example.OrderActivitiesImpl", "charge", "()V", [], True),
            ("sdk-activity-stub", "workflow-api", "io.temporal.workflow.Workflow", "newActivityStub", "()V", [], False),
        ]
        for method_id, class_id, owner, name, descriptor, annotations, has_code in methods:
            connection.execute(
                "CREATE (:JvmMethod {id:$id, stageId:'stage', classId:$classId, owner:$owner, "
                "name:$name, descriptor:$descriptor, declaration:$name, access:'public', "
                "hasCode:$hasCode, isExternalPlaceholder:false, annotations:$annotations})",
                parameters={
                    "id": method_id, "classId": class_id, "owner": owner, "name": name,
                    "descriptor": descriptor, "hasCode": has_code, "annotations": annotations,
                },
            )
            cls._relation(connection, "JvmClass", class_id, "JvmMethod", method_id,
                          "DECLARES_METHOD", "declares-" + method_id)

        cls._relation(connection, "JvmClass", "workflow-impl", "JvmClass", "workflow",
                      "BYTECODE_INTERFACE", "implements-workflow")
        cls._relation(connection, "JvmClass", "activity-impl", "JvmClass", "activity",
                      "BYTECODE_INTERFACE", "implements-activity")
        calls = [
            ("activity-call", 5, "example.OrderActivities", "charge", "activity-charge"),
            ("sdk-call", 9, "io.temporal.workflow.Workflow", "newActivityStub", "sdk-activity-stub"),
            ("signal-call", 13, "example.OrderWorkflow", "cancel", "workflow-cancel"),
        ]
        for site_id, offset, target_owner, target_name, target_method in calls:
            connection.execute(
                "CREATE (:JvmCallSite {id:$id, stageId:'stage', "
                "callerMethodId:'workflow-impl-run', bytecodeOffset:$offset, "
                "opcode:'invokeinterface', targetOwner:$owner, targetName:$name, "
                "targetDescriptor:'()V', status:'resolved'})",
                parameters={
                    "id": site_id, "offset": offset, "owner": target_owner, "name": target_name,
                },
            )
            cls._relation(connection, "JvmMethod", "workflow-impl-run", "JvmCallSite", site_id,
                          "HAS_BYTECODE_CALLSITE", "has-" + site_id)
            cls._relation(connection, "JvmCallSite", site_id, "JvmMethod", target_method,
                          "BYTECODE_RESOLVES_TO", "resolves-" + site_id)

    @staticmethod
    def _relation(
        connection: object, source_kind: str, source_id: str,
        target_kind: str, target_id: str, kind: str, relation_id: str,
    ) -> None:
        connection.execute(
            f"MATCH (source:{source_kind} {{id:$sourceId}}), "
            f"(target:{target_kind} {{id:$targetId}}) "
            "CREATE (source)-[:JvmRelation {id:$id, kind:$kind, stageId:'stage', "
            "status:'resolved', ordinal:0}]->(target)",
            parameters={
                "sourceId": source_id, "targetId": target_id,
                "id": relation_id, "kind": kind,
            },
        )


class CompactEvidenceQueryTest(unittest.TestCase):
    def test_compact_temporal_and_kafka_queries_bind_against_schema(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            database = ladybug.Database(str(Path(directory) / "compact.lbug"))
            connection = ladybug.Connection(database)
            try:
                statements = [
                    "CREATE NODE TABLE JvmArtifactEnrichmentRun(id STRING, provider STRING, PRIMARY KEY(id))",
                    "CREATE NODE TABLE JvmClass(id STRING, stageId STRING, artifactId STRING, binaryName STRING, "
                    "packageName STRING, simpleName STRING, kind STRING, sourceEntry STRING, "
                    "annotations STRING[], PRIMARY KEY(id))",
                    "CREATE NODE TABLE JvmMethod(id STRING, stageId STRING, classId STRING, owner STRING, name STRING, "
                    "descriptor STRING, annotations STRING[], annotationValuesJson STRING, PRIMARY KEY(id))",
                    "CREATE NODE TABLE JvmMethodReference(signature STRING, owner STRING, name STRING, "
                    "descriptor STRING, PRIMARY KEY(signature))",
                    "CREATE NODE TABLE JvmTypeReference(binaryName STRING, PRIMARY KEY(binaryName))",
                    "CREATE NODE TABLE ConfigurationValue(id STRING, key STRING, rawValue STRING, "
                    "resolvedValue STRING, status STRING, sourceKind STRING, scope STRING, "
                    "profileName STRING, precedence INT32, confidence DOUBLE, documentId STRING, "
                    "startLine INT32, PRIMARY KEY(id))",
                    "CREATE NODE TABLE ConfigurationReference(id STRING, valueId STRING, targetKey STRING, "
                    "kind STRING, status STRING, PRIMARY KEY(id))",
                    "CREATE NODE TABLE DeploymentUnit(id STRING, kind STRING, name STRING, namespace STRING, "
                    "documentId STRING, PRIMARY KEY(id))",
                    "CREATE REL TABLE JvmRelation(FROM JvmClass TO JvmMethod, id STRING, kind STRING)",
                    "CREATE REL TABLE JvmCompactCall(FROM JvmMethod TO JvmMethodReference, id STRING, "
                    "confidence DOUBLE, bytecodeOffset INT64, evidence STRING)",
                    "CREATE REL TABLE JvmCompactTypeReference(FROM JvmClass TO JvmTypeReference, "
                    "id STRING, kind STRING, confidence DOUBLE)",
                ]
                for statement in statements:
                    connection.execute(statement)
                client = SimpleNamespace(conn=connection)
                temporal = load_extractor("temporal")
                kafka = load_extractor("kafka")
                for query in [*temporal.queries, *kafka.queries]:
                    if query.projections == ("compact",) or query.id in {
                        "listeners", "configuration_candidates", "configuration_references", "deployments"
                    }:
                        ExtractionPipeline._execute(client, query)

                connection.execute(
                    "CREATE (:JvmArtifactEnrichmentRun {id:'stage', provider:'asm'})"
                )
                connection.execute(
                    "CREATE (:JvmClass {id:'caller-class', stageId:'stage', artifactId:'app', "
                    "binaryName:'example.Driver', packageName:'example', simpleName:'Driver', "
                    "kind:'class', sourceEntry:'example/Driver.java', annotations:[]})"
                )
                connection.execute(
                    "CREATE (:JvmClass {id:'contract-class', stageId:'stage', artifactId:'app', "
                    "binaryName:'example.OrderWorkflow', packageName:'example', "
                    "simpleName:'OrderWorkflow', kind:'interface', "
                    "sourceEntry:'example/OrderWorkflow.java', annotations:[]})"
                )
                connection.execute(
                    "CREATE (:JvmMethod {id:'caller-method', stageId:'stage', "
                    "classId:'caller-class', owner:'example.Driver', name:'drive', descriptor:'()V', "
                    "annotations:[], annotationValuesJson:'{}'})"
                )
                connection.execute(
                    "CREATE (:JvmMethod {id:'signal-method', stageId:'stage', "
                    "classId:'contract-class', owner:'example.OrderWorkflow', name:'cancel', "
                    "descriptor:'()V', annotations:['io.temporal.workflow.SignalMethod'], "
                    "annotationValuesJson:'{}'})"
                )
                connection.execute(
                    "CREATE (:JvmMethodReference {signature:'example.OrderWorkflow#cancel()V', "
                    "owner:'example.OrderWorkflow', name:'cancel', descriptor:'()V'})"
                )
                connection.execute(
                    "MATCH (c:JvmClass {id:'caller-class'}), (m:JvmMethod {id:'caller-method'}) "
                    "CREATE (c)-[:JvmRelation {id:'declares-caller', kind:'DECLARES_METHOD'}]->(m)"
                )
                connection.execute(
                    "MATCH (c:JvmClass {id:'contract-class'}), (m:JvmMethod {id:'signal-method'}) "
                    "CREATE (c)-[:JvmRelation {id:'declares-signal', kind:'DECLARES_METHOD'}]->(m)"
                )
                connection.execute(
                    "MATCH (m:JvmMethod {id:'caller-method'}), "
                    "(r:JvmMethodReference {signature:'example.OrderWorkflow#cancel()V'}) "
                    "CREATE (m)-[:JvmCompactCall {id:'signal-call', confidence:1.0, "
                    "bytecodeOffset:7, evidence:'ASM bytecode invocation'}]->(r)"
                )
                sdk_query = next(
                    query for query in temporal.queries
                    if query.id == "compact_temporal_sdk_calls"
                )
                sdk_result = ExtractionPipeline._execute(client, sdk_query)
                self.assertEqual(len(sdk_result.rows), 1)
                self.assertEqual(sdk_result.rows[0]["targetId"], "signal-method")
                self.assertEqual(sdk_result.rows[0]["targetRole"], "signal")
                self.assertEqual(sdk_result.rows[0]["providerAuthority"], "asm")
            finally:
                connection.close()
                database.close()


if __name__ == "__main__":
    unittest.main()
