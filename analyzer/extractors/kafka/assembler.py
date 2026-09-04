"""Assemble Kafka operations without choosing an unknown deployment value."""

from __future__ import annotations

import json
import re
from typing import Any, Mapping

from analyzer.extractors.core import QueryResult
from analyzer.extractors.configuration import resolve_configuration_candidates


def assemble(results: Mapping[str, QueryResult]) -> tuple[dict[str, Any], dict[str, Any]]:
    producers = [_operation(row, "producer") for row in _rows(results, "legacy_producers", "compact_producers")]
    listeners = [_listener(row) for row in _rows(results, "listeners")]
    value_rows = [row for row in _rows(results, "configuration_candidates")
                  if "kafka" in str(row.get("key", "")).lower()
                  or "topic" in str(row.get("key", "")).lower()
                  or "kafka" in str(row.get("rawValue", "")).lower()
                  or "topic" in str(row.get("rawValue", "")).lower()]
    requested_keys = _requested_keys(listeners) or [str(row.get("key", "")) for row in value_rows]
    candidates = resolve_configuration_candidates(
        value_rows, _rows(results, "configuration_references"), requested_keys,
    )
    deployments = list(_rows(results, "deployments"))
    topics = _topics(listeners, candidates)
    graph = _graph(producers, listeners, topics)
    summary = {
        "producerCount": len(producers), "listenerCount": len(listeners),
        "topicCandidateCount": len(topics), "deploymentCount": len(deployments),
        "evidenceQueryCounts": {key: len(value.rows) for key, value in results.items()},
    }
    findings = {
        "producers": producers, "listeners": listeners, "topics": topics,
        "configurationCandidates": candidates, "deployments": deployments, "graph": graph,
    }
    return summary, findings


def _rows(results: Mapping[str, QueryResult], *names: str):
    for name in names:
        result = results.get(name)
        if result:
            yield from result.rows


def _method_key(row: Mapping[str, Any]) -> str:
    owner = f"{row.get('packageName')}.{row['ownerName']}" if row.get("packageName") else row["ownerName"]
    return f"java:type:{owner}#method:{row['methodName']}{row.get('descriptor') or ''}"


def _operation(row: Mapping[str, Any], kind: str) -> dict[str, Any]:
    return {**row, "id": _method_key(row), "semanticKey": _method_key(row), "kind": kind}


def _listener(row: Mapping[str, Any]) -> dict[str, Any]:
    values: Any = {}
    try:
        values = json.loads(row.get("annotationValuesJson") or "{}")
    except (TypeError, json.JSONDecodeError):
        pass
    expressions = sorted(set(re.findall(r"\$\{[^}]+\}|[A-Za-z0-9_.-]+\.events", json.dumps(values))))
    return {**_operation(row, "listener"), "topicExpressions": expressions, "annotationValues": values}


def _requested_keys(listeners: list[dict[str, Any]]) -> list[str]:
    return sorted(set(
        match.group(1)
        for listener in listeners
        for expression in listener["topicExpressions"]
        if (match := re.fullmatch(r"\$\{([^}:]+)(?::[^}]*)?\}", expression))
    ))


def _topics(listeners: list[dict[str, Any]], candidates: list[dict[str, Any]]) -> list[dict[str, Any]]:
    topics: dict[str, dict[str, Any]] = {}
    for listener in listeners:
        for expression in listener["topicExpressions"]:
            key_match = re.fullmatch(r"\$\{([^}:]+)(?::[^}]*)?\}", expression)
            matching = [candidate for candidate in candidates if key_match and candidate["key"] == key_match.group(1)]
            for candidate in matching or [None]:
                value = candidate["value"] if candidate else expression
                item = topics.setdefault(value, {
                    "id": f"kafka:topic:{value}", "name": value, "status": candidate.get("status") if candidate else "symbolic",
                    "confidence": candidate.get("confidence") if candidate else 0.6, "evidenceIds": [],
                })
                item["evidenceIds"] = sorted(set(item["evidenceIds"] + [listener["evidenceId"]]
                    + (candidate["evidenceIds"] if candidate else [])))
    if not topics:
        for candidate in candidates:
            value = candidate["value"]
            topics[value] = {"id": f"kafka:topic:{value}", "name": value,
                "status": candidate["status"], "confidence": candidate["confidence"],
                "evidenceIds": candidate["evidenceIds"]}
    return [topics[key] for key in sorted(topics)]


def _graph(producers: list[dict[str, Any]], listeners: list[dict[str, Any]], topics: list[dict[str, Any]]) -> dict[str, Any]:
    nodes: dict[str, dict[str, Any]] = {}
    edges: list[dict[str, Any]] = []
    for operation in producers + listeners:
        nodes[operation["id"]] = {"id": operation["id"], "kind": operation["kind"],
            "label": operation["methodName"], "semanticKey": operation["semanticKey"],
            "evidenceIds": [operation["evidenceId"]], "confidence": operation["confidence"]}
    for topic in topics:
        nodes[topic["id"]] = {"id": topic["id"], "kind": "kafka_topic", "label": topic["name"],
            "evidenceIds": topic["evidenceIds"], "confidence": topic["confidence"]}
        for producer in producers:
            edges.append({"id": f"{producer['id']}->publish->{topic['id']}", "kind": "PUBLISHES_TO",
                "source": producer["id"], "target": topic["id"], "confidence": min(producer["confidence"], topic["confidence"])})
        for listener in listeners:
            edges.append({"id": f"{topic['id']}->consume->{listener['id']}", "kind": "CONSUMED_BY",
                "source": topic["id"], "target": listener["id"], "confidence": min(listener["confidence"], topic["confidence"])})
    return {"nodes": list(nodes.values()), "edges": edges, "groups": []}
