MATCH (implementation:LspMethodSymbol)-[relation:LspRelation]->(contract:LspMethodSymbol),
      (owner)-[contains:LspRelation]->(implementation)
WHERE relation.kind = 'IMPLEMENTATION_OF'
  AND contains.kind = 'CONTAINS'
OPTIONAL MATCH (document:LspDocument)-[definesOwner:LspRelation]->(owner)
WHERE definesOwner.kind = 'DEFINES'
OPTIONAL MATCH (document)-[definesPackage:LspRelation]->(package:LspPackageSymbol)
WHERE definesPackage.kind = 'DEFINES'
RETURN implementation.id AS implementationMethodId,
       implementation.name AS implementationMethodName,
       implementation.signature AS implementationSignature,
       owner.name AS implementationOwnerName,
       package.name AS implementationPackageName,
       implementation.uri AS implementationUri,
       contract.id AS contractMethodId,
       contract.name AS contractMethodName,
       relation.id AS evidenceId,
       relation.mappingConfidence AS confidence
ORDER BY implementationUri
