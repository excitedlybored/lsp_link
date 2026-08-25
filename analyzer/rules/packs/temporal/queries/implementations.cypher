MATCH (implementation:LspClassSymbol)-[relation:LspRelation]->(contract:LspInterfaceSymbol)
WHERE relation.kind = 'IMPLEMENTATION_OF'
RETURN implementation.id AS implementationId,
       implementation.name AS implementationName,
       implementation.uri AS implementationUri,
       implementation.startLine AS implementationStartLine,
       contract.id AS contractId,
       contract.name AS contractName,
       relation.id AS evidenceId,
       relation.capability AS capability,
       relation.mappingConfidence AS confidence
ORDER BY implementationUri, implementationStartLine
