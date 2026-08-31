MATCH (implementation:JvmClass)-[relation:JvmRelation]->(contract:JvmClass),
      (implementationResolution:JvmClassResolution),
      (contractResolution:JvmClassResolution)
WHERE relation.kind = 'BYTECODE_INTERFACE'
  AND implementationResolution.binaryName = implementation.binaryName
  AND implementation.id = implementationResolution.classId
  AND implementation.artifactId = implementationResolution.artifactId
  AND contractResolution.binaryName = contract.binaryName
  AND contract.id = contractResolution.classId
  AND contract.artifactId = contractResolution.artifactId
  AND (
    list_contains(contract.annotations, $workflowContractType)
    OR list_contains(contract.annotations, $activityContractType)
  )
RETURN DISTINCT implementation.id AS implementationId,
       implementation.simpleName AS implementationName,
       implementation.packageName AS implementationPackageName,
       implementation.sourceEntry AS implementationUri,
       -1 AS implementationStartLine,
       contract.id AS contractId,
       contract.simpleName AS contractName,
       relation.id AS evidenceId,
       'jvm/BYTECODE_INTERFACE' AS capability,
       1.0 AS confidence
ORDER BY implementationPackageName, implementationName, contractName
