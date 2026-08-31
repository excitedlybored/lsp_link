MATCH (contract:JvmClass),
      (contractResolution:JvmClassResolution)
WHERE contractResolution.binaryName = contract.binaryName
  AND contract.id = contractResolution.classId
  AND contract.artifactId = contractResolution.artifactId
  AND contract.kind = 'interface'
  AND list_contains(contract.annotations, $activityContractType)
RETURN DISTINCT contract.id AS contractId,
       contract.simpleName AS contractName,
       contract.packageName AS packageName,
       contract.sourceEntry AS uri,
       -1 AS startLine,
       contract.id AS evidenceId,
       $activityContractType AS semanticType,
       'jvm-activity-contract-annotation' AS evidence,
       1.0 AS confidence
ORDER BY packageName, contractName
