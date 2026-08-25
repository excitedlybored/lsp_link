MATCH (document:LspDocument)-[defined:LspRelation]->(contract:LspInterfaceSymbol),
      (document)-[hasHover:LspRelation]->(hover:LspHover),
      (hover)-[binding:LspJvmBinding]->(activityContractType:JvmClass)
WHERE defined.kind = 'DEFINES'
  AND hasHover.kind = 'HAS_HOVER'
  AND binding.kind = 'HOVER_TARGET'
  AND activityContractType.binaryName = $activityContractType
  AND hover.requestLine = contract.startLine
OPTIONAL MATCH (document)-[definesPackage:LspRelation]->(package:LspPackageSymbol)
WHERE definesPackage.kind = 'DEFINES'
RETURN DISTINCT contract.id AS contractId,
       contract.name AS contractName,
       package.name AS packageName,
       contract.uri AS uri,
       contract.startLine AS startLine,
       hover.id AS evidenceId,
       activityContractType.id AS semanticTypeId,
       activityContractType.binaryName AS semanticType,
       'activity-contract-type' AS evidence,
       binding.confidence AS confidence
ORDER BY uri, startLine

