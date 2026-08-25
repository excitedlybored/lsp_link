MATCH (implementation:LspClassSymbol)-[relation:LspRelation]->(contract:LspInterfaceSymbol)
WHERE relation.kind = 'IMPLEMENTATION_OF'
OPTIONAL MATCH (document:LspDocument)-[definesImplementation:LspRelation]->(implementation)
WHERE definesImplementation.kind = 'DEFINES'
OPTIONAL MATCH (document)-[definesPackage:LspRelation]->(package:LspPackageSymbol)
WHERE definesPackage.kind = 'DEFINES'
RETURN implementation.id AS implementationId,
       implementation.name AS implementationName,
       package.name AS implementationPackageName,
       implementation.uri AS implementationUri,
       implementation.startLine AS implementationStartLine,
       contract.id AS contractId,
       contract.name AS contractName,
       relation.id AS evidenceId,
       relation.capability AS capability,
       relation.mappingConfidence AS confidence
ORDER BY implementationUri, implementationStartLine
