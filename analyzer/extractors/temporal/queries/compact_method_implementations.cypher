MATCH (implementationClass:JvmClass)-[interfaceRelation:JvmCompactTypeReference]->(reference:JvmTypeReference),
      (contractClass:JvmClass),
      (implementationClass)-[declaresImplementation:JvmRelation]->(implementation:JvmMethod),
      (contractClass)-[declaresContract:JvmRelation]->(contract:JvmMethod)
WHERE interfaceRelation.kind = 'INTERFACE' AND reference.binaryName = contractClass.binaryName
  AND declaresImplementation.kind = 'DECLARES_METHOD'
  AND declaresContract.kind = 'DECLARES_METHOD'
  AND implementation.name = contract.name AND implementation.descriptor = contract.descriptor
  AND (list_contains(contractClass.annotations, $workflowContractType)
    OR list_contains(contractClass.annotations, $activityContractType))
RETURN DISTINCT implementation.id AS implementationMethodId,
       implementation.name AS implementationMethodName,
       implementation.descriptor AS implementationSignature,
       implementationClass.simpleName AS implementationOwnerName,
       implementationClass.packageName AS implementationPackageName,
       implementationClass.sourceEntry AS implementationUri,
       contract.id AS contractMethodId, contract.name AS contractMethodName,
       interfaceRelation.id AS evidenceId, interfaceRelation.confidence AS confidence
ORDER BY implementationPackageName, implementationOwnerName, implementationMethodName
