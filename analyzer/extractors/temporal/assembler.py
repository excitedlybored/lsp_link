"""Assemble Temporal concepts from scalable JVM facts and optional LSP evidence."""

from __future__ import annotations

from collections import defaultdict
import hashlib
import json
from typing import Any, Mapping

from analyzer.extractors.core import QueryResult


def assemble(results: Mapping[str, QueryResult]) -> tuple[dict[str, Any], dict[str, Any]]:
    sdk_rows = _all_rows(results, "sdk_classes", "compact_sdk_classes")
    workflow_contracts, workflow_aliases = _contracts(_all_rows(
        results, "workflow_contracts", "jvm_workflow_contracts", "compact_workflow_contracts"
    ))
    activity_contracts, activity_aliases = _contracts(_all_rows(
        results, "activity_contracts", "jvm_activity_contracts", "compact_activity_contracts"
    ))
    contract_aliases = {**workflow_aliases, **activity_aliases}
    workflow_ids = set(workflow_contracts)
    activity_ids = set(activity_contracts)

    methods_by_owner_and_key: dict[str, dict[tuple[str, str], dict[str, Any]]] = defaultdict(dict)
    method_aliases: dict[str, str] = {}
    for method in _all_rows(results, "annotated_methods", "jvm_annotated_methods", "compact_annotated_methods"):
        owner_id = contract_aliases.get(
            method["ownerId"],
            _type_semantic_key(method.get("packageName"), method["ownerName"], "interface"),
        )
        semantic_key = _method_semantic_key(
            method.get("packageName"), method["ownerName"], method["methodName"],
            method.get("signature"),
        )
        key = (method["methodName"], method["methodRole"])
        jvm_signature = _jvm_method_signature(
            method.get("packageName"), method["ownerName"], method["methodName"],
            method.get("signature"),
        )
        existing = methods_by_owner_and_key[owner_id].get(key)
        if existing is None:
            method_aliases[method["methodId"]] = semantic_key
            method_aliases[jvm_signature] = semantic_key
            methods_by_owner_and_key[owner_id][key] = {
                **method,
                "id": semantic_key,
                "semanticKey": semantic_key,
                "lbugNodeId": method["methodId"],
                "lbugNodeIds": [method["methodId"]],
                "evidenceIds": [method["evidenceId"]],
            }
        else:
            method_aliases[method["methodId"]] = existing["semanticKey"]
            method_aliases[jvm_signature] = existing["semanticKey"]
            _append_unique(existing["lbugNodeIds"], method["methodId"])
            _append_unique(existing["evidenceIds"], method["evidenceId"])
            existing["confidence"] = max(existing["confidence"], method["confidence"])
    methods_by_owner = {
        owner_id: sorted(
            methods.values(), key=lambda row: (row.get("startLine") or -1, row["methodName"])
        )
        for owner_id, methods in methods_by_owner_and_key.items()
    }

    implementations_by_contract_key: dict[str, dict[str, dict[str, Any]]] = defaultdict(dict)
    implementation_aliases: dict[str, str] = {}
    for implementation in _all_rows(results, "implementations", "jvm_implementations", "compact_implementations"):
        contract_id = contract_aliases.get(implementation["contractId"])
        if contract_id not in workflow_ids | activity_ids:
            continue
        implementation_key = _type_semantic_key(
            implementation.get("implementationPackageName"),
            implementation["implementationName"], "class",
        )
        implementation_aliases[implementation["implementationId"]] = implementation_key
        existing = implementations_by_contract_key[contract_id].get(implementation_key)
        if existing is None:
            implementations_by_contract_key[contract_id][implementation_key] = {
                **implementation,
                "lbugNodeIds": [implementation["implementationId"]],
                "evidenceIds": [implementation["evidenceId"]],
            }
        else:
            _append_unique(existing["lbugNodeIds"], implementation["implementationId"])
            _append_unique(existing["evidenceIds"], implementation["evidenceId"])
            existing["confidence"] = max(existing["confidence"], implementation["confidence"])
            if not existing.get("implementationUri") and implementation.get("implementationUri"):
                existing["implementationUri"] = implementation["implementationUri"]
                existing["implementationStartLine"] = implementation["implementationStartLine"]
    implementations_by_contract = {
        contract_id: list(implementations.values())
        for contract_id, implementations in implementations_by_contract_key.items()
    }
    implementation_ids = set(implementation_aliases.values())

    concrete_methods_by_contract_method: dict[str, list[dict[str, Any]]] = defaultdict(list)
    concrete_method_keys: dict[str, set[str]] = defaultdict(set)
    concrete_method_aliases: dict[str, str] = {}
    for implementation in _all_rows(
        results, "method_implementations", "jvm_method_implementations", "compact_method_implementations"
    ):
        contract_method_id = method_aliases.get(implementation["contractMethodId"])
        if contract_method_id is None:
            continue
        implementation_method_key = _method_semantic_key(
            implementation.get("implementationPackageName"),
            implementation["implementationOwnerName"],
            implementation["implementationMethodName"],
            implementation.get("implementationSignature"),
        )
        concrete_method_aliases[implementation["implementationMethodId"]] = (
            implementation_method_key
        )
        if implementation_method_key in concrete_method_keys[contract_method_id]:
            continue
        concrete_method_keys[contract_method_id].add(implementation_method_key)
        concrete_methods_by_contract_method[contract_method_id].append(implementation)

    temporal_callsite_ids = {
        row["callSiteId"] for row in _all_rows(
            results, "temporal_sdk_calls", "jvm_temporal_sdk_calls", "compact_temporal_sdk_calls"
        )
    }
    calls_by_owner: dict[str, list[dict[str, Any]]] = defaultdict(list)
    callsite_ids_by_owner: dict[str, set[str]] = defaultdict(set)
    for call in _all_rows(results, "resolved_calls", "jvm_resolved_calls", "compact_resolved_calls"):
        caller_owner = implementation_aliases.get(call["callerOwnerId"])
        if caller_owner not in implementation_ids:
            continue
        if call["callSiteId"] in callsite_ids_by_owner[caller_owner]:
            continue
        callsite_ids_by_owner[caller_owner].add(call["callSiteId"])
        calls_by_owner[caller_owner].append(_classify_call(
            call, activity_ids, activity_aliases, temporal_callsite_ids
        ))

    workflows = []
    for contract_id, contract in sorted(
        workflow_contracts.items(),
        key=lambda item: (item[1].get("uri") or "", item[1].get("startLine") or -1),
    ):
        contract_methods = methods_by_owner.get(contract_id, [])
        implementations = []
        for implementation in implementations_by_contract.get(contract_id, []):
            implementation_key = _type_semantic_key(
                implementation.get("implementationPackageName"),
                implementation["implementationName"], "class",
            )
            concrete_methods = []
            for contract_method in contract_methods:
                concrete_methods.extend(
                    concrete_methods_by_contract_method.get(contract_method["semanticKey"], [])
                )
            implementations.append({
                "id": implementation_key,
                "semanticKey": implementation_key,
                "lbugNodeId": implementation["implementationId"],
                "lbugNodeIds": implementation["lbugNodeIds"],
                "evidenceIds": implementation["evidenceIds"],
                "name": implementation["implementationName"],
                "uri": implementation.get("implementationUri"),
                "startLine": implementation.get("implementationStartLine", -1),
                "confidence": implementation["confidence"],
                "methods": [_concrete_method(method) for method in concrete_methods],
                "calls": calls_by_owner.get(implementation_key, []),
            })
        workflows.append({**contract, "methods": contract_methods, "implementations": implementations})

    activities = []
    for contract_id, contract in sorted(
        activity_contracts.items(),
        key=lambda item: (item[1].get("uri") or "", item[1].get("startLine") or -1),
    ):
        contract_methods = methods_by_owner.get(contract_id, [])
        activity_implementations = []
        for row in implementations_by_contract.get(contract_id, []):
            concrete_methods = []
            for contract_method in contract_methods:
                concrete_methods.extend(
                    concrete_methods_by_contract_method.get(contract_method["semanticKey"], [])
                )
            activity_implementations.append({
                "id": _type_semantic_key(
                    row.get("implementationPackageName"), row["implementationName"], "class"
                ),
                "semanticKey": _type_semantic_key(
                    row.get("implementationPackageName"), row["implementationName"], "class"
                ),
                "lbugNodeId": row["implementationId"],
                "lbugNodeIds": row["lbugNodeIds"],
                "evidenceIds": row["evidenceIds"],
                "name": row["implementationName"],
                "uri": row.get("implementationUri"),
                "confidence": row["confidence"],
                "methods": [_concrete_method(method) for method in concrete_methods],
            })
        activities.append({
            **contract,
            "methods": contract_methods,
            "implementations": activity_implementations,
        })

    runtime_calls = []
    seen_runtime_calls: set[str] = set()
    for call in _all_rows(results, "temporal_sdk_calls", "jvm_temporal_sdk_calls", "compact_temporal_sdk_calls"):
        if call["callSiteId"] in seen_runtime_calls:
            continue
        seen_runtime_calls.add(call["callSiteId"])
        runtime_calls.append({**call, "operation": _runtime_operation(call)})

    activity_calls = [
        call
        for workflow in workflows
        for implementation in workflow["implementations"]
        for call in implementation["calls"]
        if call["classification"] == "activity"
    ]
    graph = _build_workflow_graph(
        workflows,
        activities,
        runtime_calls,
        {**method_aliases, **concrete_method_aliases},
        implementation_aliases,
    )
    code_evidence = _build_visualization_graph(
        workflows,
        activities,
        runtime_calls,
        {**method_aliases, **concrete_method_aliases},
        implementation_aliases,
    )
    graph["supportingEvidence"] = {
        **code_evidence,
        "perspective": "java-evidence",
        "bindings": _bind_workflow_to_code(graph["nodes"], code_evidence),
    }
    summary = {
        "temporalSdkPresent": bool(sdk_rows),
        "temporalSdkClassCount": len(sdk_rows),
        "workflowCount": len(workflows),
        "confirmedWorkflowCount": len(workflows),
        "inferredWorkflowCount": 0,
        "activityContractCount": len(activities),
        "confirmedActivityContractCount": len(activities),
        "workflowImplementationCount": sum(len(item["implementations"]) for item in workflows),
        "activityImplementationCount": sum(len(item["implementations"]) for item in activities),
        "activityInvocationObservationCount": len({call["callSiteId"] for call in activity_calls}),
        "activityInvocationCount": _logical_invocation_count(activity_calls),
        "temporalRuntimeCallObservationCount": len({call["callSiteId"] for call in runtime_calls}),
        "temporalRuntimeCallCount": _logical_invocation_count(runtime_calls),
        "visualizationNodeCount": len(graph["nodes"]),
        "visualizationEdgeCount": len(graph["edges"]),
        "visualizationGroupCount": len(graph["groups"]),
        "visualizationCodeEvidenceNodeCount": len(code_evidence["nodes"]),
        "visualizationCodeEvidenceEdgeCount": len(code_evidence["edges"]),
        "visualizationCodeBindingCount": len(graph["supportingEvidence"]["bindings"]),
        "evidenceQueryCounts": {key: len(value.rows) for key, value in results.items()},
    }
    findings = {
        "workflows": workflows,
        "activities": activities,
        "runtimeCalls": runtime_calls,
        "graph": graph,
        "dependencyEvidence": {
            "sdkClassCount": len(sdk_rows),
            "artifacts": sorted({row["artifactId"] for row in sdk_rows}),
        },
    }
    return summary, findings


def _build_workflow_graph(
    workflows: list[dict[str, Any]],
    activities: list[dict[str, Any]],
    runtime_calls: list[dict[str, Any]],
    method_aliases: Mapping[str, str],
    implementation_aliases: Mapping[str, str],
) -> dict[str, Any]:
    """Project code evidence into workflow concepts suitable for flow diagrams."""
    nodes: dict[str, dict[str, Any]] = {}
    edges: dict[tuple[str, str, str, str], dict[str, Any]] = {}
    groups: dict[str, dict[str, Any]] = {}
    node_groups: dict[str, set[str]] = defaultdict(set)
    method_roles: dict[str, str] = {}
    method_labels: dict[str, str] = {}
    contract_method_by_concrete: dict[str, str] = {}
    workflow_group_by_implementation: dict[str, str] = {}
    workflow_group_by_method: dict[str, str] = {}
    activity_methods: set[str] = set()

    def add_node(
        node_id: str,
        kind: str,
        label: str,
        *,
        group_ids: set[str] | None = None,
        evidence_ids: list[str] | None = None,
        properties: Mapping[str, Any] | None = None,
    ) -> str:
        node = nodes.setdefault(node_id, {
            "id": node_id,
            "kind": kind,
            "label": label,
            "groupIds": [],
            "evidenceIds": [],
            "properties": {},
        })
        node["evidenceIds"] = sorted(set(
            node["evidenceIds"] + [value for value in (evidence_ids or []) if value]
        ))
        node["properties"].update({
            key: value for key, value in (properties or {}).items() if value is not None
        })
        node_groups[node_id].update(group_ids or set())
        return node_id

    def add_edge(
        kind: str,
        source: str,
        target: str,
        label: str,
        *,
        group_ids: set[str] | None = None,
        evidence_ids: list[str] | None = None,
        observation: Mapping[str, Any] | None = None,
    ) -> None:
        key = (kind, source, target, label)
        edge = edges.setdefault(key, {
            "kind": kind,
            "source": source,
            "target": target,
            "label": label,
            "groupIds": set(),
            "evidenceIds": set(),
            "observations": {},
        })
        edge["groupIds"].update(group_ids or set())
        edge["evidenceIds"].update(value for value in (evidence_ids or []) if value)
        if observation:
            observation_id = str(observation.get("id") or _stable_id("observation", observation))
            edge["observations"][observation_id] = {
                key: value for key, value in observation.items() if value is not None
            }

    for workflow in workflows:
        workflow_id = f"workflow:{workflow['semanticKey']}"
        group_id = _stable_id("workflow-group", workflow["semanticKey"])
        groups[group_id] = {
            "id": group_id,
            "kind": "workflow",
            "label": workflow["name"],
            "rootNodeId": workflow_id,
        }
        add_node(
            workflow_id, "workflow", workflow["name"], group_ids={group_id},
            evidence_ids=workflow.get("evidence", []) + workflow.get("lbugNodeIds", []),
            properties={
                "semanticKey": workflow["semanticKey"],
                "uri": workflow.get("uri"),
                "startLine": workflow.get("startLine"),
            },
        )
        for method in workflow.get("methods", []):
            method_id = f"operation:{method['semanticKey']}"
            role = method.get("methodRole") or "workflow"
            method_roles[method["semanticKey"]] = role
            method_labels[method["semanticKey"]] = method["methodName"]
            workflow_group_by_method[method["semanticKey"]] = group_id
            add_node(
                method_id, _workflow_operation_kind(role), method["methodName"],
                group_ids={group_id},
                evidence_ids=method.get("evidenceIds", []) + method.get("lbugNodeIds", []),
                properties={
                    "role": role,
                    "semanticKey": method["semanticKey"],
                    "signature": method.get("signature"),
                    "uri": method.get("uri"),
                    "startLine": method.get("startLine"),
                },
            )
            add_edge(
                _workflow_membership_edge(role), workflow_id, method_id,
                role.replace("_", " "), group_ids={group_id},
                evidence_ids=method.get("evidenceIds", []),
            )
        for implementation in workflow.get("implementations", []):
            workflow_group_by_implementation[implementation["semanticKey"]] = group_id
            for method in implementation.get("methods", []):
                contract_method = method_aliases.get(method.get("contractMethodId"))
                if not contract_method:
                    continue
                contract_method_by_concrete[method["semanticKey"]] = contract_method
                contract_method_by_concrete[method["implementationMethodId"]] = contract_method

    for activity in activities:
        activity_id = f"activity:{activity['semanticKey']}"
        add_node(
            activity_id, "activity", activity["name"],
            evidence_ids=activity.get("evidence", []) + activity.get("lbugNodeIds", []),
            properties={"semanticKey": activity["semanticKey"], "uri": activity.get("uri")},
        )
        for method in activity.get("methods", []):
            method_id = f"operation:{method['semanticKey']}"
            activity_methods.add(method["semanticKey"])
            method_labels[method["semanticKey"]] = method["methodName"]
            add_node(
                method_id, "activity_operation", method["methodName"],
                evidence_ids=method.get("evidenceIds", []) + method.get("lbugNodeIds", []),
                properties={
                    "semanticKey": method["semanticKey"],
                    "signature": method.get("signature"),
                    "uri": method.get("uri"),
                },
            )
            add_edge("PROVIDES_ACTIVITY", activity_id, method_id, "provides activity")
        for implementation in activity.get("implementations", []):
            for method in implementation.get("methods", []):
                contract_method = method_aliases.get(method.get("contractMethodId"))
                if not contract_method:
                    continue
                contract_method_by_concrete[method["semanticKey"]] = contract_method
                contract_method_by_concrete[method["implementationMethodId"]] = contract_method

    runtime_by_callsite = {call["callSiteId"]: call for call in runtime_calls}
    call_rows: list[dict[str, Any]] = []
    seen_calls: set[str] = set()
    for workflow in workflows:
        for implementation in workflow.get("implementations", []):
            for call in implementation.get("calls", []):
                callsite_id = call["callSiteId"]
                call_rows.append({**call, **runtime_by_callsite.get(callsite_id, {})})
                seen_calls.add(callsite_id)
    call_rows.extend(call for call in runtime_calls if call["callSiteId"] not in seen_calls)

    for call in call_rows:
        caller_owner = implementation_aliases.get(call.get("callerOwnerId"))
        caller_semantic = method_aliases.get(call.get("callerId"))
        caller_semantic = contract_method_by_concrete.get(
            caller_semantic or call.get("callerId"), caller_semantic
        )
        group_id = workflow_group_by_implementation.get(caller_owner)
        if not group_id and caller_semantic:
            group_id = workflow_group_by_method.get(caller_semantic)
        group_ids = {group_id} if group_id else set()
        if caller_semantic and caller_semantic in method_roles:
            source = f"operation:{caller_semantic}"
        else:
            source_key = caller_semantic or call.get("callerId") or _stable_id("caller", call)
            source = f"step:{source_key}"
            add_node(
                source, "workflow_step", call.get("callerName") or "workflow step",
                group_ids=group_ids,
                evidence_ids=[call.get("callerId")],
                properties={"uri": call.get("callerUri")},
            )

        target_semantic = method_aliases.get(call.get("targetId"))
        target_semantic = contract_method_by_concrete.get(
            target_semantic or call.get("targetId"), target_semantic
        )
        operation = call.get("operation")
        if target_semantic in activity_methods:
            target = f"operation:{target_semantic}"
            edge_kind = "INVOKES_ACTIVITY"
            label = "invokes activity"
        elif target_semantic in method_roles:
            target = f"operation:{target_semantic}"
            edge_kind, label = _temporal_flow_edge(method_roles[target_semantic])
        elif operation:
            target = f"temporal-operation:{operation}"
            add_node(
                target, "temporal_operation", operation.replace("_", " "),
                group_ids=group_ids,
                evidence_ids=[call.get("targetId"), call.get("targetJvmClassId")],
                properties={"operation": operation},
            )
            edge_kind, label = _temporal_flow_edge(operation)
        else:
            target_key = target_semantic or call.get("targetId") or _stable_id("target", call)
            target = f"step:{target_key}"
            add_node(
                target, "workflow_step", call.get("targetName") or "workflow step",
                group_ids=group_ids,
                evidence_ids=[call.get("targetId")],
                properties={"uri": call.get("targetUri")},
            )
            edge_kind = "NEXT_STEP"
            label = call.get("targetName") or "calls"
        node_groups[source].update(group_ids)
        node_groups[target].update(group_ids)
        observation = {
            "id": call.get("callSiteId"),
            "logicalInvocationId": call.get("logicalInvocationId"),
            "source": call.get("evidenceSource") or (
                "jvm-bytecode" if call.get("bytecodeOffset") is not None else "lsp"
            ),
            "providerAuthority": call.get("providerAuthority"),
            "uri": call.get("callerUri"),
            "startLine": call.get("startLine"),
            "startCharacter": call.get("startCharacter"),
            "endLine": call.get("endLine"),
            "endCharacter": call.get("endCharacter"),
            "bytecodeOffset": call.get("bytecodeOffset"),
            "confidence": call.get("confidence"),
        }
        add_edge(
            edge_kind, source, target, label, group_ids=group_ids,
            evidence_ids=[call.get("callSiteId"), call.get("logicalInvocationId")],
            observation=observation,
        )

    rendered_edges = []
    for key in sorted(edges):
        edge = edges[key]
        rendered_edges.append({
            "id": _stable_id("flow", {
                "kind": key[0], "source": key[1], "target": key[2], "label": key[3]
            }),
            "kind": edge["kind"],
            "source": edge["source"],
            "target": edge["target"],
            "label": edge["label"],
            "groupIds": sorted(edge["groupIds"]),
            "observationCount": len(edge["observations"]),
            "evidenceIds": sorted(edge["evidenceIds"]),
            "observations": [
                edge["observations"][key] for key in sorted(edge["observations"])
            ],
        })
    for node_id, node in nodes.items():
        node["groupIds"] = sorted(node_groups[node_id])
    rendered_nodes = [nodes[key] for key in sorted(nodes)]
    rendered_groups = []
    for group_id in sorted(groups):
        rendered_groups.append({
            **groups[group_id],
            "nodeIds": sorted(
                node["id"] for node in rendered_nodes if group_id in node["groupIds"]
            ),
            "edgeIds": sorted(
                edge["id"] for edge in rendered_edges if group_id in edge["groupIds"]
            ),
        })
    return {
        "schemaVersion": 1,
        "perspective": "workflow",
        "directed": True,
        "nodeKinds": sorted({node["kind"] for node in rendered_nodes}),
        "edgeKinds": sorted({edge["kind"] for edge in rendered_edges}),
        "nodes": rendered_nodes,
        "edges": rendered_edges,
        "groups": rendered_groups,
    }


def _workflow_operation_kind(role: str) -> str:
    return {
        "workflow": "workflow_entrypoint",
        "signal": "signal_handler",
        "query": "query_handler",
        "update": "update_handler",
    }.get(role, "workflow_operation")


def _workflow_membership_edge(role: str) -> str:
    return {
        "workflow": "HAS_ENTRYPOINT",
        "signal": "HAS_SIGNAL_HANDLER",
        "query": "HAS_QUERY_HANDLER",
        "update": "HAS_UPDATE_HANDLER",
    }.get(role, "HAS_OPERATION")


def _temporal_flow_edge(operation: str) -> tuple[str, str]:
    return {
        "workflow": ("INVOKES_WORKFLOW", "invokes workflow"),
        "invoke_workflow_entrypoint": ("INVOKES_WORKFLOW", "invokes workflow"),
        "signal": ("SIGNALS", "signals"),
        "query": ("QUERIES", "queries"),
        "update": ("UPDATES", "updates"),
        "start_workflow": ("STARTS_WORKFLOW", "starts workflow"),
        "create_child_workflow_stub": ("PREPARES_CHILD_WORKFLOW", "prepares child workflow"),
        "create_activity_stub": ("PREPARES_ACTIVITY", "prepares activity"),
        "create_local_activity_stub": ("PREPARES_ACTIVITY", "prepares local activity"),
        "register_workflow_implementation": (
            "REGISTERS_WORKFLOW", "registers workflow"
        ),
        "register_activity_implementation": (
            "REGISTERS_ACTIVITY", "registers activity"
        ),
    }.get(operation, ("USES_TEMPORAL_API", operation.replace("_", " ")))


def _bind_workflow_to_code(
    workflow_nodes: list[dict[str, Any]],
    code_graph: Mapping[str, Any],
) -> list[dict[str, Any]]:
    """Link workflow concepts to Java evidence without making Java the primary view."""
    code_nodes = code_graph["nodes"]
    by_semantic_key: dict[str, set[str]] = defaultdict(set)
    by_lbug_id: dict[str, set[str]] = defaultdict(set)
    for node in code_nodes:
        if node.get("semanticKey"):
            by_semantic_key[node["semanticKey"]].add(node["id"])
        for lbug_id in node.get("lbugNodeIds", []):
            by_lbug_id[lbug_id].add(node["id"])

    implementations_by_contract: dict[str, set[str]] = defaultdict(set)
    for edge in code_graph["edges"]:
        if edge["kind"] in {"IMPLEMENTS", "IMPLEMENTS_METHOD"}:
            implementations_by_contract[edge["target"]].add(edge["source"])

    bindings = []
    for workflow_node in workflow_nodes:
        code_node_ids: set[str] = set()
        semantic_key = workflow_node.get("properties", {}).get("semanticKey")
        if semantic_key:
            code_node_ids.update(by_semantic_key.get(semantic_key, set()))
        for evidence_id in workflow_node.get("evidenceIds", []):
            code_node_ids.update(by_lbug_id.get(evidence_id, set()))
        for code_node_id in list(code_node_ids):
            code_node_ids.update(implementations_by_contract.get(code_node_id, set()))
        if not code_node_ids:
            continue
        bindings.append({
            "id": _stable_id("code-binding", {
                "workflowNodeId": workflow_node["id"],
                "codeNodeIds": sorted(code_node_ids),
            }),
            "workflowNodeId": workflow_node["id"],
            "codeNodeIds": sorted(code_node_ids),
            "relationship": "EVIDENCED_BY",
        })
    return sorted(bindings, key=lambda binding: binding["workflowNodeId"])


def _build_visualization_graph(
    workflows: list[dict[str, Any]],
    activities: list[dict[str, Any]],
    runtime_calls: list[dict[str, Any]],
    method_aliases: Mapping[str, str],
    implementation_aliases: Mapping[str, str],
) -> dict[str, Any]:
    """Build a deterministic graph projection without discarding evidence detail."""
    nodes: dict[str, dict[str, Any]] = {}
    edges: dict[tuple[str, str, str, str], dict[str, Any]] = {}
    type_aliases: dict[str, str] = dict(implementation_aliases)
    node_groups: dict[str, set[str]] = defaultdict(set)
    workflow_group_by_implementation: dict[str, str] = {}
    groups: dict[str, dict[str, Any]] = {}

    def add_node(
        node_id: str,
        kind: str,
        label: str,
        *,
        semantic_key: str | None = None,
        lbug_node_ids: list[str] | None = None,
        group_ids: set[str] | None = None,
        properties: Mapping[str, Any] | None = None,
    ) -> str:
        clean_properties = {
            key: value for key, value in (properties or {}).items() if value is not None
        }
        existing = nodes.get(node_id)
        if existing is None:
            existing = {
                "id": node_id,
                "kind": kind,
                "label": label,
                "semanticKey": semantic_key,
                "lbugNodeIds": sorted(set(lbug_node_ids or [])),
                "groupIds": [],
                "properties": clean_properties,
            }
            nodes[node_id] = existing
        else:
            existing["lbugNodeIds"] = sorted(set(
                existing["lbugNodeIds"] + list(lbug_node_ids or [])
            ))
            existing["properties"].update(clean_properties)
            if semantic_key and not existing.get("semanticKey"):
                existing["semanticKey"] = semantic_key
        for group_id in group_ids or set():
            node_groups[node_id].add(group_id)
        return node_id

    def add_edge(
        kind: str,
        source: str,
        target: str,
        label: str,
        *,
        group_ids: set[str] | None = None,
        evidence_ids: list[str] | None = None,
        observation: Mapping[str, Any] | None = None,
        properties: Mapping[str, Any] | None = None,
    ) -> None:
        key = (kind, source, target, label)
        edge = edges.setdefault(key, {
            "kind": kind,
            "source": source,
            "target": target,
            "label": label,
            "groupIds": set(),
            "evidenceIds": set(),
            "observations": {},
            "properties": {},
        })
        edge["groupIds"].update(group_ids or set())
        edge["evidenceIds"].update(value for value in (evidence_ids or []) if value)
        edge["properties"].update({
            key: value for key, value in (properties or {}).items() if value is not None
        })
        if observation:
            observation_id = str(observation.get("id") or _stable_id("observation", observation))
            edge["observations"][observation_id] = {
                key: value for key, value in observation.items() if value is not None
            }

    def register_contract(
        contract: dict[str, Any], kind: str, group_id: str | None = None,
    ) -> None:
        groups_for_node = {group_id} if group_id else set()
        add_node(
            contract["semanticKey"], kind, contract["name"],
            semantic_key=contract["semanticKey"],
            lbug_node_ids=contract.get("lbugNodeIds", []),
            group_ids=groups_for_node,
            properties={
                "uri": contract.get("uri"),
                "startLine": contract.get("startLine"),
                "confidence": contract.get("confidence"),
            },
        )
        for alias in contract.get("lbugNodeIds", []):
            type_aliases[alias] = contract["semanticKey"]
        for method in contract.get("methods", []):
            add_node(
                method["semanticKey"], "method", method["methodName"],
                semantic_key=method["semanticKey"],
                lbug_node_ids=method.get("lbugNodeIds", []),
                group_ids=groups_for_node,
                properties={
                    "role": method.get("methodRole"),
                    "signature": method.get("signature"),
                    "uri": method.get("uri"),
                    "startLine": method.get("startLine"),
                    "confidence": method.get("confidence"),
                },
            )
            add_edge(
                "DECLARES", contract["semanticKey"], method["semanticKey"], "declares",
                group_ids=groups_for_node, evidence_ids=method.get("evidenceIds", []),
            )

    def register_implementation(
        implementation: dict[str, Any], contract: dict[str, Any],
        kind: str, group_id: str | None = None,
    ) -> None:
        groups_for_node = {group_id} if group_id else set()
        add_node(
            implementation["semanticKey"], kind, implementation["name"],
            semantic_key=implementation["semanticKey"],
            lbug_node_ids=implementation.get("lbugNodeIds", []),
            group_ids=groups_for_node,
            properties={
                "uri": implementation.get("uri"),
                "startLine": implementation.get("startLine"),
                "confidence": implementation.get("confidence"),
            },
        )
        for alias in implementation.get("lbugNodeIds", []):
            type_aliases[alias] = implementation["semanticKey"]
        add_edge(
            "IMPLEMENTS", implementation["semanticKey"], contract["semanticKey"],
            "implements", group_ids=groups_for_node,
            evidence_ids=implementation.get("evidenceIds", []),
        )
        for method in implementation.get("methods", []):
            add_node(
                method["semanticKey"], "method", method["implementationMethodName"],
                semantic_key=method["semanticKey"],
                lbug_node_ids=[method["implementationMethodId"]],
                group_ids=groups_for_node,
                properties={
                    "signature": method.get("implementationSignature"),
                    "uri": method.get("implementationUri"),
                    "startLine": method.get("implementationStartLine"),
                    "confidence": method.get("confidence"),
                },
            )
            add_edge(
                "DECLARES", implementation["semanticKey"], method["semanticKey"], "declares",
                group_ids=groups_for_node,
            )
            contract_method = method_aliases.get(method.get("contractMethodId"))
            if contract_method:
                add_edge(
                    "IMPLEMENTS_METHOD", method["semanticKey"], contract_method,
                    "implements method", group_ids=groups_for_node,
                    evidence_ids=[method.get("evidenceId")],
                )

    for workflow in workflows:
        group_id = _stable_id("workflow", workflow["semanticKey"])
        groups[group_id] = {
            "id": group_id,
            "kind": "workflow",
            "label": workflow["name"],
            "rootNodeId": workflow["semanticKey"],
        }
        register_contract(workflow, "workflow_contract", group_id)
        for implementation in workflow["implementations"]:
            workflow_group_by_implementation[implementation["semanticKey"]] = group_id
            register_implementation(
                implementation, workflow, "workflow_implementation", group_id
            )

    for activity in activities:
        register_contract(activity, "activity_contract")
        for implementation in activity["implementations"]:
            register_implementation(
                implementation, activity, "activity_implementation"
            )

    runtime_by_callsite = {call["callSiteId"]: call for call in runtime_calls}
    call_rows: list[dict[str, Any]] = []
    seen_calls: set[str] = set()
    for workflow in workflows:
        for implementation in workflow["implementations"]:
            for call in implementation["calls"]:
                callsite_id = call["callSiteId"]
                runtime = runtime_by_callsite.get(callsite_id, {})
                call_rows.append({**call, **runtime})
                seen_calls.add(callsite_id)
    call_rows.extend(call for call in runtime_calls if call["callSiteId"] not in seen_calls)

    for call in call_rows:
        caller_owner = type_aliases.get(call.get("callerOwnerId"))
        caller_groups = (
            {workflow_group_by_implementation[caller_owner]}
            if caller_owner in workflow_group_by_implementation else set()
        )
        if not caller_owner and call.get("callerOwnerId"):
            caller_owner = f"lbug:class:{call['callerOwnerId']}"
            add_node(
                caller_owner, "application_class", call.get("callerOwnerName") or caller_owner,
                lbug_node_ids=[call["callerOwnerId"]], group_ids=caller_groups,
                properties={"packageName": call.get("callerOwnerPackageName")},
            )
        caller = method_aliases.get(call.get("callerId"))
        if not caller:
            caller = f"lbug:method:{call.get('callerId') or _stable_id('caller', call)}"
            add_node(
                caller, "method", call.get("callerName") or "unknown caller",
                lbug_node_ids=[call["callerId"]] if call.get("callerId") else [],
                group_ids=caller_groups,
                properties={"uri": call.get("callerUri")},
            )
        if caller_owner:
            add_edge("DECLARES", caller_owner, caller, "declares", group_ids=caller_groups)

        target_owner_id = call.get("targetOwnerId") or call.get("targetJvmClassId")
        target_owner = type_aliases.get(target_owner_id)
        target_binary_name = call.get("targetJvmClass")
        is_temporal_sdk = bool(
            target_binary_name and target_binary_name.startswith("io.temporal.")
        )
        if not target_owner and target_owner_id:
            target_owner = f"lbug:class:{target_owner_id}"
            add_node(
                target_owner,
                "temporal_sdk_type" if is_temporal_sdk else "application_class",
                call.get("targetOwnerName") or target_binary_name or target_owner,
                lbug_node_ids=[target_owner_id],
                group_ids=caller_groups,
                properties={
                    "binaryName": target_binary_name,
                    "packageName": call.get("targetOwnerPackageName"),
                    "artifactId": call.get("targetArtifactId"),
                },
            )
        target = method_aliases.get(call.get("targetId"))
        if not target:
            target = f"lbug:method:{call.get('targetId') or _stable_id('target', call)}"
            add_node(
                target, "temporal_sdk_method" if is_temporal_sdk else "method",
                call.get("targetName") or call.get("requestedCallee") or "unknown target",
                lbug_node_ids=[call["targetId"]] if call.get("targetId") else [],
                group_ids=caller_groups,
                properties={"uri": call.get("targetUri"), "role": call.get("targetRole")},
            )
        if target_owner:
            add_edge("DECLARES", target_owner, target, "declares", group_ids=caller_groups)
        for related_node in (caller_owner, caller, target_owner, target):
            if related_node:
                node_groups[related_node].update(caller_groups)

        label = call.get("operation") or call.get("classification") or "call"
        evidence_ids = [call.get("callSiteId"), call.get("logicalInvocationId")]
        observation = {
            "id": call.get("callSiteId"),
            "logicalInvocationId": call.get("logicalInvocationId"),
            "source": call.get("evidenceSource") or (
                "jvm-bytecode" if call.get("bytecodeOffset") is not None else "lsp"
            ),
            "providerAuthority": call.get("providerAuthority"),
            "uri": call.get("callerUri"),
            "startLine": call.get("startLine"),
            "startCharacter": call.get("startCharacter"),
            "endLine": call.get("endLine"),
            "endCharacter": call.get("endCharacter"),
            "bytecodeOffset": call.get("bytecodeOffset"),
            "confidence": call.get("confidence"),
        }
        add_edge(
            "CALLS", caller, target, label,
            group_ids=caller_groups,
            evidence_ids=[value for value in evidence_ids if value],
            observation=observation,
            properties={
                "classification": call.get("classification"),
                "operation": call.get("operation"),
                "targetRole": call.get("targetRole"),
            },
        )

    rendered_edges = []
    for key in sorted(edges):
        edge = edges[key]
        edge_id = _stable_id("edge", {"kind": key[0], "source": key[1], "target": key[2], "label": key[3]})
        rendered_edges.append({
            "id": edge_id,
            "kind": edge["kind"],
            "source": edge["source"],
            "target": edge["target"],
            "label": edge["label"],
            "groupIds": sorted(edge["groupIds"]),
            "observationCount": len(edge["observations"]),
            "evidenceIds": sorted(edge["evidenceIds"]),
            "observations": [edge["observations"][key] for key in sorted(edge["observations"])],
            "properties": edge["properties"],
        })
    for node_id, node in nodes.items():
        node["groupIds"] = sorted(node_groups[node_id])
    rendered_nodes = [nodes[key] for key in sorted(nodes)]
    rendered_groups = []
    for group_id in sorted(groups):
        group = groups[group_id]
        rendered_groups.append({
            **group,
            "nodeIds": sorted(
                node["id"] for node in rendered_nodes if group_id in node["groupIds"]
            ),
            "edgeIds": sorted(
                edge["id"] for edge in rendered_edges if group_id in edge["groupIds"]
            ),
        })
    return {
        "schemaVersion": 1,
        "directed": True,
        "nodeKinds": sorted({node["kind"] for node in rendered_nodes}),
        "edgeKinds": sorted({edge["kind"] for edge in rendered_edges}),
        "nodes": rendered_nodes,
        "edges": rendered_edges,
        "groups": rendered_groups,
    }


def _stable_id(namespace: str, value: Any) -> str:
    serialized = json.dumps(value, sort_keys=True, separators=(",", ":"), default=str)
    digest = hashlib.sha256(serialized.encode("utf-8")).hexdigest()[:20]
    return f"{namespace}:{digest}"


def _rows(results: Mapping[str, QueryResult], key: str) -> list[dict[str, Any]]:
    result = results.get(key)
    return result.rows if result else []


def _all_rows(results: Mapping[str, QueryResult], *keys: str) -> list[dict[str, Any]]:
    return [row for key in keys for row in _rows(results, key)]


def _contracts(
    rows: list[dict[str, Any]],
) -> tuple[dict[str, dict[str, Any]], dict[str, str]]:
    contracts: dict[str, dict[str, Any]] = {}
    aliases: dict[str, str] = {}
    for row in rows:
        semantic_key = _type_semantic_key(
            row.get("packageName"), row["contractName"], "interface"
        )
        aliases[row["contractId"]] = semantic_key
        existing = contracts.get(semantic_key)
        if existing is None:
            contracts[semantic_key] = {
                "id": semantic_key,
                "semanticKey": semantic_key,
                "lbugNodeId": row["contractId"],
                "lbugNodeIds": [row["contractId"]],
                "name": row["contractName"],
                "uri": row.get("uri"),
                "startLine": row.get("startLine", -1),
                "detection": "confirmed",
                "confidence": row["confidence"],
                "evidence": [row["evidence"], row["evidenceId"]],
            }
            continue
        _append_unique(existing["lbugNodeIds"], row["contractId"])
        _append_unique(existing["evidence"], row["evidence"])
        _append_unique(existing["evidence"], row["evidenceId"])
        existing["confidence"] = max(existing["confidence"], row["confidence"])
        if not existing.get("uri") and row.get("uri"):
            existing["uri"] = row["uri"]
            existing["startLine"] = row.get("startLine", -1)
    return contracts, aliases


def _concrete_method(method: dict[str, Any]) -> dict[str, Any]:
    semantic_key = _method_semantic_key(
        method.get("implementationPackageName"), method["implementationOwnerName"],
        method["implementationMethodName"], method.get("implementationSignature"),
    )
    return {
        **method,
        "id": semantic_key,
        "semanticKey": semantic_key,
        "lbugNodeId": method["implementationMethodId"],
    }


def _append_unique(values: list[Any], value: Any) -> None:
    if value not in values:
        values.append(value)


def _type_semantic_key(package: Any, name: str, kind: str) -> str:
    qualified_name = f"{package}.{name}" if package else name
    return f"java:{kind}:{qualified_name}"


def _method_semantic_key(
    package: Any, owner_name: str, method_name: str, signature: Any,
) -> str:
    owner_key = _type_semantic_key(package, owner_name, "type")
    return f"{owner_key}#method:{method_name}{signature or ''}"


def _jvm_method_signature(
    package: Any, owner_name: str, method_name: str, signature: Any,
) -> str:
    owner = f"{package}.{owner_name}" if package else owner_name
    return f"{owner}#{method_name}{signature or ''}"


def _classify_call(
    call: dict[str, Any],
    activity_ids: set[str],
    activity_aliases: Mapping[str, str],
    temporal_callsite_ids: set[str],
) -> dict[str, Any]:
    if activity_aliases.get(call.get("targetOwnerId")) in activity_ids:
        classification = "activity"
    elif call.get("callSiteId") in temporal_callsite_ids:
        classification = "temporal_sdk"
    else:
        classification = "application"
    return {**call, "classification": classification}


def _logical_invocation_count(calls: list[dict[str, Any]]) -> int:
    logical_ids = {call["logicalInvocationId"] for call in calls if call.get("logicalInvocationId")}
    bytecode_ids = {call["callSiteId"] for call in calls if not call.get("logicalInvocationId")}
    return len(logical_ids) + len(bytecode_ids)


def _runtime_operation(call: dict[str, Any]) -> str:
    target_role = call.get("targetRole")
    if target_role == "workflow":
        return "invoke_workflow_entrypoint"
    if target_role in {"signal", "query", "update"}:
        return target_role
    name = f"{call.get('requestedCallee') or ''} {call.get('targetName') or ''}"
    if "registerWorkflowImplementationTypes" in name:
        return "register_workflow_implementation"
    if "registerActivitiesImplementations" in name:
        return "register_activity_implementation"
    if "newLocalActivityStub" in name:
        return "create_local_activity_stub"
    if "newActivityStub" in name:
        return "create_activity_stub"
    if "newChildWorkflowStub" in name:
        return "create_child_workflow_stub"
    if "newWorkflowStub" in name:
        return "create_workflow_stub"
    if "signalWithStart" in name:
        return "signal_with_start"
    if "signal" in name.lower():
        return "signal"
    if "query" in name.lower():
        return "query"
    if "start(" in name or call.get("targetName") == "start":
        return "start_workflow"
    return "temporal_api"
