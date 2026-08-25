MATCH (implementation:LspMethodSymbol)-[relation:LspRelation]->(contract:LspMethodSymbol)
WHERE relation.kind = 'IMPLEMENTATION_OF'
RETURN implementation.id AS implementationMethodId,
       implementation.name AS implementationMethodName,
       implementation.uri AS implementationUri,
       contract.id AS contractMethodId,
       contract.name AS contractMethodName,
       relation.id AS evidenceId,
       relation.mappingConfidence AS confidence
ORDER BY implementationUri
