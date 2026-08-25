MATCH (document:LspDocument)-[defined:LspRelation]->(contract:LspInterfaceSymbol),
      (document)-[hasHover:LspRelation]->(hover:LspHover)
WHERE defined.kind = 'DEFINES'
  AND hasHover.kind = 'HAS_HOVER'
  AND hover.contents CONTAINS 'io.temporal.activity.ActivityInterface'
  AND hover.requestLine = contract.startLine
RETURN DISTINCT contract.id AS contractId,
       contract.name AS contractName,
       contract.uri AS uri,
       contract.startLine AS startLine,
       hover.id AS evidenceId,
       'hover:io.temporal.activity.ActivityInterface' AS evidence,
       1.0 AS confidence
ORDER BY uri, startLine
