"""Strict semantic-flow parity gate for legacy and compact Ladybug databases."""

from __future__ import annotations

import argparse
import json
from typing import Any, Iterable

from analyzer.extractors.core import ExtractionPipeline, load_extractor
from analyzer.extractors.run import _compose_graphs


def normalized_semantics(reports: Iterable[Any]) -> dict[str, Any]:
    normalized = {}
    report_list = list(reports)
    for report in report_list:
        normalized[report.extractor_id] = _normalize_graph(report.findings.get("graph", {}))
    normalized["composed"] = _normalize_graph(_compose_graphs(report_list))
    return normalized


def compare_databases(baseline: str, candidate: str, extractor_ids: list[str]) -> dict[str, Any]:
    baseline_reports = [ExtractionPipeline(baseline).run(load_extractor(name)) for name in extractor_ids]
    candidate_reports = [ExtractionPipeline(candidate).run(load_extractor(name)) for name in extractor_ids]
    expected = normalized_semantics(baseline_reports)
    actual = normalized_semantics(candidate_reports)
    if expected != actual:
        raise RuntimeError(json.dumps({
            "status": "failed", "baseline": expected, "candidate": actual,
        }, indent=2, default=str))
    return {"status": "passed", "extractors": extractor_ids, "semantics": actual}


def _normalize_graph(graph: dict[str, Any]) -> dict[str, Any]:
    nodes = [*graph.get("nodes", []), *graph.get("supportingEvidence", {}).get("nodes", [])]
    edges = [*graph.get("edges", []), *graph.get("supportingEvidence", {}).get("edges", [])]
    identities = {}
    normalized_nodes = set()
    for node in nodes:
        identity = (node.get("semanticKey") or node.get("properties", {}).get("semanticKey")
                    or f"{node.get('kind')}:{node.get('label')}")
        identities[node.get("id")] = identity
        normalized_nodes.add((str(node.get("kind")), str(identity)))
    normalized_edges = {
        (str(edge.get("kind")), str(identities.get(edge.get("source"), edge.get("source"))),
         str(identities.get(edge.get("target"), edge.get("target"))))
        for edge in edges
        if edge.get("kind") != "SAME_SEMANTIC_ENTITY"
    }
    return {
        "nodes": sorted(normalized_nodes),
        "edges": sorted(normalized_edges),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Compare normalized semantic paths across JVM schemas")
    parser.add_argument("baseline")
    parser.add_argument("candidate")
    parser.add_argument("--extractor", action="append", required=True)
    args = parser.parse_args()
    print(json.dumps(compare_databases(args.baseline, args.candidate, args.extractor), indent=2))


if __name__ == "__main__":
    main()
