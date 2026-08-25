"""Assemble Temporal concepts and workflow flows from normalized query evidence."""

from __future__ import annotations

from collections import defaultdict
from typing import Any, Mapping

from analyzer.extractors.core import QueryResult


def assemble(results: Mapping[str, QueryResult]) -> tuple[dict[str, Any], dict[str, Any]]:
    sdk_rows = _rows(results, "sdk_classes")
    sdk_present = bool(sdk_rows)

    workflow_contracts = _contracts(_rows(results, "workflow_contracts"))
    activity_contracts = _contracts(_rows(results, "activity_contracts"))
    workflow_ids = set(workflow_contracts)
    activity_ids = set(activity_contracts)

    methods_by_owner_and_key: dict[str, dict[tuple[str, str], dict[str, Any]]] = defaultdict(dict)
    for method in _rows(results, "annotated_methods"):
        key = (method["methodId"], method["methodRole"])
        existing = methods_by_owner_and_key[method["ownerId"]].get(key)
        if existing is None:
            semantic_key = _method_semantic_key(
                method.get("packageName"),
                method["ownerName"],
                method["methodName"],
                method.get("signature"),
            )
            methods_by_owner_and_key[method["ownerId"]][key] = {
                **method,
                "id": semantic_key,
                "semanticKey": semantic_key,
                "lbugNodeId": method["methodId"],
                "evidenceIds": [method["evidenceId"]],
            }
        elif method["evidenceId"] not in existing["evidenceIds"]:
            existing["evidenceIds"].append(method["evidenceId"])
    methods_by_owner = {
        owner_id: sorted(methods.values(), key=lambda row: (row["startLine"], row["methodName"]))
        for owner_id, methods in methods_by_owner_and_key.items()
    }

    implementations_by_contract: dict[str, list[dict[str, Any]]] = defaultdict(list)
    implementation_ids: set[str] = set()
    for implementation in _rows(results, "implementations"):
        if implementation["contractId"] not in workflow_ids | activity_ids:
            continue
        implementations_by_contract[implementation["contractId"]].append(implementation)
        implementation_ids.add(implementation["implementationId"])

    method_implementations = _rows(results, "method_implementations")
    concrete_methods_by_contract_method: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for implementation in method_implementations:
        concrete_methods_by_contract_method[implementation["contractMethodId"]].append(implementation)

    temporal_callsite_ids = {
        row["callSiteId"] for row in _rows(results, "temporal_sdk_calls")
    }
    calls_by_owner: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for call in _rows(results, "resolved_calls"):
        if call["callerOwnerId"] in implementation_ids:
            calls_by_owner[call["callerOwnerId"]].append(
                _classify_call(call, activity_ids, temporal_callsite_ids)
            )

    workflows = []
    for contract_id, contract in sorted(
        workflow_contracts.items(), key=lambda item: (item[1]["uri"], item[1]["startLine"])
    ):
        contract_methods = methods_by_owner.get(contract_id, [])
        implementations = []
        for implementation in implementations_by_contract.get(contract_id, []):
            implementation_key = _type_semantic_key(
                implementation.get("implementationPackageName"),
                implementation["implementationName"],
                "class",
            )
            concrete_methods = []
            for contract_method in contract_methods:
                concrete_methods.extend(
                    concrete_methods_by_contract_method.get(contract_method["methodId"], [])
                )
            implementations.append({
                "id": implementation_key,
                "semanticKey": implementation_key,
                "lbugNodeId": implementation["implementationId"],
                "name": implementation["implementationName"],
                "uri": implementation["implementationUri"],
                "startLine": implementation["implementationStartLine"],
                "confidence": implementation["confidence"],
                "methods": [
                    {
                        **method,
                        "id": _method_semantic_key(
                            method.get("implementationPackageName"),
                            method["implementationOwnerName"],
                            method["implementationMethodName"],
                            method.get("implementationSignature"),
                        ),
                        "semanticKey": _method_semantic_key(
                            method.get("implementationPackageName"),
                            method["implementationOwnerName"],
                            method["implementationMethodName"],
                            method.get("implementationSignature"),
                        ),
                        "lbugNodeId": method["implementationMethodId"],
                    }
                    for method in concrete_methods
                ],
                "calls": calls_by_owner.get(implementation["implementationId"], []),
            })
        workflows.append({
            **contract,
            "methods": contract_methods,
            "implementations": implementations,
        })

    activities = []
    for contract_id, contract in sorted(
        activity_contracts.items(), key=lambda item: (item[1]["uri"], item[1]["startLine"])
    ):
        activities.append({
            **contract,
            "methods": methods_by_owner.get(contract_id, []),
            "implementations": [
                {
                    "id": _type_semantic_key(
                        row.get("implementationPackageName"),
                        row["implementationName"],
                        "class",
                    ),
                    "semanticKey": _type_semantic_key(
                        row.get("implementationPackageName"),
                        row["implementationName"],
                        "class",
                    ),
                    "lbugNodeId": row["implementationId"],
                    "name": row["implementationName"],
                    "uri": row["implementationUri"],
                    "confidence": row["confidence"],
                }
                for row in implementations_by_contract.get(contract_id, [])
            ],
        })

    runtime_calls = []
    for call in _rows(results, "temporal_sdk_calls"):
        runtime_calls.append({**call, "operation": _runtime_operation(call)})

    confirmed_workflows = sum(item["detection"] == "confirmed" for item in workflows)
    confirmed_activities = sum(item["detection"] == "confirmed" for item in activities)
    activity_calls = [
        call
        for workflow in workflows
        for implementation in workflow["implementations"]
        for call in implementation["calls"]
        if call["classification"] == "activity"
    ]
    activity_observation_ids = {call["callSiteId"] for call in activity_calls}
    activity_invocation_ids = {
        call["logicalInvocationId"] for call in activity_calls
        if call.get("logicalInvocationId")
    }
    runtime_observation_ids = {call["callSiteId"] for call in runtime_calls}
    runtime_invocation_ids = {
        call["logicalInvocationId"] for call in runtime_calls
        if call.get("logicalInvocationId")
    }
    summary = {
        "temporalSdkPresent": sdk_present,
        "temporalSdkClassCount": len(sdk_rows),
        "workflowCount": len(workflows),
        "confirmedWorkflowCount": confirmed_workflows,
        "inferredWorkflowCount": 0,
        "activityContractCount": len(activities),
        "confirmedActivityContractCount": confirmed_activities,
        "workflowImplementationCount": sum(len(item["implementations"]) for item in workflows),
        "activityImplementationCount": sum(len(item["implementations"]) for item in activities),
        "activityInvocationObservationCount": len(activity_observation_ids),
        "activityInvocationCount": len(activity_invocation_ids),
        "temporalRuntimeCallObservationCount": len(runtime_observation_ids),
        "temporalRuntimeCallCount": len(runtime_invocation_ids),
        "evidenceQueryCounts": {key: len(value.rows) for key, value in results.items()},
    }
    findings = {
        "workflows": workflows,
        "activities": activities,
        "runtimeCalls": runtime_calls,
        "dependencyEvidence": {
            "sdkClassCount": len(sdk_rows),
            "artifacts": sorted({row["artifactId"] for row in sdk_rows}),
        },
    }
    return summary, findings


def _rows(results: Mapping[str, QueryResult], key: str) -> list[dict[str, Any]]:
    return results[key].rows


def _contracts(rows: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    contracts: dict[str, dict[str, Any]] = {}
    for row in rows:
        existing = contracts.get(row["contractId"])
        if existing is None:
            semantic_key = _type_semantic_key(
                row.get("packageName"), row["contractName"], "interface"
            )
            contracts[row["contractId"]] = {
                "id": semantic_key,
                "semanticKey": semantic_key,
                "lbugNodeId": row["contractId"],
                "name": row["contractName"],
                "uri": row["uri"],
                "startLine": row["startLine"],
                "detection": "confirmed",
                "confidence": row["confidence"],
                "evidence": [row["evidence"], row["evidenceId"]],
            }
            continue
        for evidence in (row["evidence"], row["evidenceId"]):
            if evidence not in existing["evidence"]:
                existing["evidence"].append(evidence)
    return contracts


def _type_semantic_key(package: Any, name: str, kind: str) -> str:
    qualified_name = f"{package}.{name}" if package else name
    return f"java:{kind}:{qualified_name}"


def _method_semantic_key(
    package: Any,
    owner_name: str,
    method_name: str,
    signature: Any,
) -> str:
    owner_key = _type_semantic_key(package, owner_name, "type")
    return f"{owner_key}#method:{method_name}{signature or ''}"


def _classify_call(
    call: dict[str, Any],
    activity_ids: set[str],
    temporal_callsite_ids: set[str],
) -> dict[str, Any]:
    if call.get("targetOwnerId") in activity_ids:
        classification = "activity"
    elif call.get("callSiteId") in temporal_callsite_ids:
        classification = "temporal_sdk"
    else:
        classification = "application"
    return {**call, "classification": classification}


def _runtime_operation(call: dict[str, Any]) -> str:
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
    if "start(" in name:
        return "start_workflow"
    return "temporal_api"
