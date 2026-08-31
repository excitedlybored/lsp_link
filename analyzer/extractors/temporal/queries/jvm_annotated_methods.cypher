MATCH (owner:JvmClass)-[declares:JvmRelation]->(method:JvmMethod),
      (ownerResolution:JvmClassResolution)
WHERE declares.kind = 'DECLARES_METHOD'
  AND ownerResolution.binaryName = owner.binaryName
  AND owner.id = ownerResolution.classId
  AND owner.artifactId = ownerResolution.artifactId
  AND owner.kind = 'interface'
  AND (
    list_contains(method.annotations, $workflowEntryPointType)
    OR list_contains(method.annotations, $signalEntryPointType)
    OR list_contains(method.annotations, $queryEntryPointType)
    OR list_contains(method.annotations, $updateEntryPointType)
    OR list_contains(owner.annotations, $activityContractType)
  )
RETURN DISTINCT owner.id AS ownerId,
       owner.simpleName AS ownerName,
       owner.packageName AS packageName,
       method.id AS methodId,
       method.name AS methodName,
       method.descriptor AS signature,
       owner.sourceEntry AS uri,
       -1 AS startLine,
       CASE
         WHEN list_contains(method.annotations, $workflowEntryPointType) THEN 'workflow'
         WHEN list_contains(method.annotations, $signalEntryPointType) THEN 'signal'
         WHEN list_contains(method.annotations, $queryEntryPointType) THEN 'query'
         WHEN list_contains(method.annotations, $updateEntryPointType) THEN 'update'
         ELSE 'activity'
       END AS methodRole,
       CASE
         WHEN list_contains(method.annotations, $workflowEntryPointType) THEN $workflowEntryPointType
         WHEN list_contains(method.annotations, $signalEntryPointType) THEN $signalEntryPointType
         WHEN list_contains(method.annotations, $queryEntryPointType) THEN $queryEntryPointType
         WHEN list_contains(method.annotations, $updateEntryPointType) THEN $updateEntryPointType
         ELSE $activityContractType
       END AS semanticType,
       method.id AS evidenceId,
       1.0 AS confidence
ORDER BY packageName, ownerName, methodName, signature
