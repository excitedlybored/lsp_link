MATCH (contract:JvmClass)-[declares:JvmRelation]->(method:JvmMethod),
      (contractResolution:JvmClassResolution)
WHERE declares.kind = 'DECLARES_METHOD'
  AND contractResolution.binaryName = contract.binaryName
  AND contract.id = contractResolution.classId
  AND contract.artifactId = contractResolution.artifactId
  AND contract.kind = 'interface'
  AND (
    list_contains(contract.annotations, $workflowContractType)
    OR list_contains(method.annotations, $workflowEntryPointType)
  )
RETURN DISTINCT contract.id AS contractId,
       contract.simpleName AS contractName,
       contract.packageName AS packageName,
       contract.sourceEntry AS uri,
       -1 AS startLine,
       contract.id AS evidenceId,
       CASE
         WHEN list_contains(contract.annotations, $workflowContractType)
           THEN $workflowContractType
         ELSE $workflowEntryPointType
       END AS semanticType,
       CASE
         WHEN list_contains(contract.annotations, $workflowContractType)
           THEN 'jvm-workflow-contract-annotation'
         ELSE 'jvm-workflow-entry-point-annotation'
       END AS evidence,
       1.0 AS confidence
ORDER BY packageName, contractName
