MATCH (implementation:JvmClass)-[relation:JvmCompactTypeReference]->(reference:JvmTypeReference),
      (contract:JvmClass)
WHERE relation.kind = 'INTERFACE' AND reference.binaryName = contract.binaryName
  AND (list_contains(contract.annotations, $workflowContractType)
    OR list_contains(contract.annotations, $activityContractType))
RETURN DISTINCT implementation.id AS implementationId,
       implementation.simpleName AS implementationName,
       implementation.packageName AS implementationPackageName,
       implementation.sourceEntry AS implementationUri,
       -1 AS implementationStartLine,
       contract.id AS contractId, contract.simpleName AS contractName,
       relation.id AS evidenceId, 'jvm/INTERFACE' AS capability,
       relation.confidence AS confidence
ORDER BY implementationPackageName, implementationName, contractName
