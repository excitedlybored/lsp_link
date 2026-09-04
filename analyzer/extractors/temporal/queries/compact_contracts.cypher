MATCH (run:JvmArtifactEnrichmentRun),
      (contract:JvmClass)-[declares:JvmRelation]->(method:JvmMethod)
WHERE declares.kind = 'DECLARES_METHOD'
  AND run.id = contract.stageId
  AND contract.kind = 'interface'
  AND ($contractKind = 'workflow' AND (
    list_contains(contract.annotations, $contractType)
    OR list_contains(method.annotations, $methodType)
  ) OR $contractKind = 'activity' AND list_contains(contract.annotations, $contractType))
RETURN DISTINCT contract.id AS contractId,
       contract.simpleName AS contractName,
       contract.packageName AS packageName,
       contract.sourceEntry AS uri,
       -1 AS startLine,
       contract.id AS evidenceId,
       $contractType AS semanticType,
       run.provider AS evidence,
       1.0 AS confidence
ORDER BY packageName, contractName
