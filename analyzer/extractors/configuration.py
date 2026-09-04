"""Framework-neutral configuration candidate resolution with provenance."""

from __future__ import annotations

import re
from collections import defaultdict
from typing import Any, Iterable, Mapping


def resolve_configuration_candidates(
    values: Iterable[Mapping[str, Any]],
    references: Iterable[Mapping[str, Any]],
    requested_keys: Iterable[str],
) -> list[dict[str, Any]]:
    """Return every reachable candidate; never choose an unknown runtime scope."""
    value_rows = [dict(value) for value in values]
    by_key: dict[str, list[dict[str, Any]]] = defaultdict(list)
    by_id = {}
    for value in value_rows:
        by_key[str(value.get("key", ""))].append(value)
        by_id[str(value.get("evidenceId", ""))] = value
    refs_by_value: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for reference in references:
        refs_by_value[str(reference.get("valueId", ""))].append(dict(reference))

    resolved: dict[tuple[str, str, str], dict[str, Any]] = {}

    def visit(key: str, chain: list[str], seen: set[str]) -> None:
        if key in seen:
            return
        for value in by_key.get(key, []):
            evidence_id = str(value.get("evidenceId", ""))
            next_chain = [*chain, evidence_id]
            candidates = []
            if value.get("resolvedValue") is not None:
                candidates.append(str(value["resolvedValue"]))
            default = re.search(r"\$\{[^}:]+:([^}]*)\}", str(value.get("rawValue", "")))
            if default and default.group(1):
                candidates.append(default.group(1))
            if value.get("status") == "exact" and value.get("rawValue") is not None:
                candidates.append(str(value["rawValue"]))
            for candidate in candidates:
                identity = (key, candidate, str(value.get("scope", "")))
                current = resolved.setdefault(identity, {
                    "key": key, "value": candidate, "status": value.get("status", "unresolved"),
                    "scope": value.get("scope"), "profile": value.get("profile", value.get("profileName")),
                    "sourceKind": value.get("sourceKind"), "precedence": value.get("precedence", 0),
                    "confidence": value.get("confidence", 0.5), "evidenceIds": [],
                })
                current["evidenceIds"] = sorted(set(current["evidenceIds"] + next_chain))
            for reference in refs_by_value.get(evidence_id, []):
                visit(str(reference.get("targetKey", "")), next_chain, {*seen, key})

    for requested in sorted(set(requested_keys)):
        visit(requested, [], set())
    return sorted(resolved.values(), key=lambda item: (
        item["key"], -int(item["precedence"] or 0), str(item["scope"] or ""), item["value"],
    ))
