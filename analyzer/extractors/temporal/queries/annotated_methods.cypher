MATCH (owner:LspInterfaceSymbol)-[contains:LspRelation]->(method:LspMethodSymbol),
      (document:LspDocument)-[defined:LspRelation]->(owner),
      (document)-[hasHover:LspRelation]->(hover:LspHover),
      (hover)-[binding:LspJvmBinding]->(semanticType:JvmClass),
      (semanticTypeResolution:JvmClassResolution)
WHERE contains.kind = 'CONTAINS'
  AND defined.kind = 'DEFINES'
  AND hasHover.kind = 'HAS_HOVER'
  AND binding.kind = 'HOVER_TARGET'
  AND semanticTypeResolution.binaryName = semanticType.binaryName
  AND semanticType.id = semanticTypeResolution.classId
  AND semanticType.artifactId = semanticTypeResolution.artifactId
  AND (
    (
      hover.requestLine = method.startLine
      AND (
        semanticType.binaryName = $workflowEntryPointType
        OR semanticType.binaryName = $signalEntryPointType
        OR semanticType.binaryName = $queryEntryPointType
        OR semanticType.binaryName = $updateEntryPointType
      )
    )
    OR (
      hover.requestLine = owner.startLine
      AND semanticType.binaryName = $activityContractType
    )
  )
OPTIONAL MATCH (document)-[definesPackage:LspRelation]->(package:LspPackageSymbol)
WHERE definesPackage.kind = 'DEFINES'
RETURN DISTINCT owner.id AS ownerId,
       owner.name AS ownerName,
       package.name AS packageName,
       method.id AS methodId,
       method.name AS methodName,
       method.signature AS signature,
       method.uri AS uri,
       method.startLine AS startLine,
       CASE
         WHEN semanticType.binaryName = $workflowEntryPointType THEN 'workflow'
         WHEN semanticType.binaryName = $signalEntryPointType THEN 'signal'
         WHEN semanticType.binaryName = $queryEntryPointType THEN 'query'
         WHEN semanticType.binaryName = $updateEntryPointType THEN 'update'
         ELSE 'activity'
       END AS methodRole,
       semanticType.id AS semanticTypeId,
       semanticType.binaryName AS semanticType,
       hover.id AS evidenceId,
       binding.confidence AS confidence
ORDER BY uri, startLine
