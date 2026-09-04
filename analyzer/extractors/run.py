#!/usr/bin/env python3
"""CLI for semantic extraction from an LSP-native .lbug database."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

try:
    from analyzer.extractors.core import ExtractionPipeline, load_extractor
except ImportError:
    from core import ExtractionPipeline, load_extractor


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Extract framework semantics from LadybugDB evidence"
    )
    parser.add_argument("database", help="Direct .lbug path or an indexed project")
    parser.add_argument(
        "--extractor",
        action="append",
        help="Semantic extractor under analyzer/extractors",
    )
    parser.add_argument("--output", help="Write the JSON report to this path")
    parser.add_argument("--include-raw", action="store_true", help="Include every query row")
    args = parser.parse_args()

    extractor_ids = args.extractor or ["temporal"]
    reports = [ExtractionPipeline(args.database).run(load_extractor(value)) for value in extractor_ids]
    payload = reports[0].to_dict(include_raw=args.include_raw) if len(reports) == 1 else {
        "database": reports[0].database,
        "extractors": [report.to_dict(include_raw=args.include_raw) for report in reports],
        "summary": {"extractorCount": len(reports), "qualifications": {
            report.extractor_id: report.qualification for report in reports
        }},
        "findings": {
            "byExtractor": {report.extractor_id: report.findings for report in reports},
            "graph": _compose_graphs(reports),
        },
    }
    rendered = json.dumps(payload, indent=2, default=str)
    if args.output:
        output = Path(args.output).expanduser().resolve()
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(rendered + "\n", encoding="utf-8")
        print(f"Wrote {', '.join(extractor_ids)} extraction report to {output}")
    else:
        print(rendered)


def _compose_graphs(reports):
    nodes = {}
    edges = {}
    semantic_ids = {}
    for report in reports:
        graph = report.findings.get("graph", {})
        for node in graph.get("nodes", []):
            nodes.setdefault(node["id"], node)
            semantic_key = node.get("semanticKey") or node.get("properties", {}).get("semanticKey")
            if semantic_key:
                semantic_ids.setdefault(semantic_key, set()).add(node["id"])
        supporting = graph.get("supportingEvidence", {})
        for node in supporting.get("nodes", []):
            nodes.setdefault(node["id"], node)
            semantic_key = node.get("semanticKey") or node.get("properties", {}).get("semanticKey")
            if semantic_key:
                semantic_ids.setdefault(semantic_key, set()).add(node["id"])
        for edge in [*graph.get("edges", []), *supporting.get("edges", [])]:
            key = edge.get("id") or f"{edge.get('kind')}:{edge.get('source')}:{edge.get('target')}"
            edges.setdefault(key, edge)
    for semantic_key, identifiers in semantic_ids.items():
        ordered = sorted(identifiers)
        for target in ordered[1:]:
            edge_id = f"semantic:{ordered[0]}:{target}"
            edges[edge_id] = {"id": edge_id, "kind": "SAME_SEMANTIC_ENTITY",
                "source": ordered[0], "target": target, "semanticKey": semantic_key,
                "confidence": 1.0}
    return {"nodes": list(nodes.values()), "edges": list(edges.values()), "groups": []}


if __name__ == "__main__":
    main()
