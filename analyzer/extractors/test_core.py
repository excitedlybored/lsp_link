"""Contract tests for portable, LadybugDB-only semantic extractors."""

from __future__ import annotations

import unittest

from analyzer.extractors.core import (
    EvidenceQuery,
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


if __name__ == "__main__":
    unittest.main()
