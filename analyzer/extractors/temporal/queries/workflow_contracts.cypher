MATCH (document:LspDocument)-[defined:LspRelation]->(contract:LspInterfaceSymbol),
      (contract)-[contains:LspRelation]->(method:LspMethodSymbol),
      (document)-[hasHover:LspRelation]->(hover:LspHover),
      (hover)-[binding:LspJvmBinding]->(semanticType:JvmClass),
      (semanticTypeResolution:JvmClassResolution)
WHERE defined.kind = 'DEFINES'
  AND contains.kind = 'CONTAINS'
  AND hasHover.kind = 'HAS_HOVER'
  AND binding.kind = 'HOVER_TARGET'
  AND semanticTypeResolution.binaryName = semanticType.binaryName
  AND semanticType.id = semanticTypeResolution.classId
  AND semanticType.artifactId = semanticTypeResolution.artifactId
  AND (
    (semanticType.binaryName = $workflowContractType
      AND hover.requestLine = contract.startLine)
    OR
    (semanticType.binaryName = $workflowEntryPointType
      AND hover.requestLine = method.startLine)
  )
OPTIONAL MATCH (document)-[definesPackage:LspRelation]->(package:LspPackageSymbol)
WHERE definesPackage.kind = 'DEFINES'
RETURN DISTINCT contract.id AS contractId,
       contract.name AS contractName,
       package.name AS packageName,
       contract.uri AS uri,
       contract.startLine AS startLine,
       hover.id AS evidenceId,
       semanticType.id AS semanticTypeId,
       semanticType.binaryName AS semanticType,
       CASE
         WHEN semanticType.binaryName = $workflowContractType
           THEN 'workflow-contract-type'
         ELSE 'workflow-entry-point-type'
       END AS evidence,
       binding.confidence AS confidence
ORDER BY uri, startLine
