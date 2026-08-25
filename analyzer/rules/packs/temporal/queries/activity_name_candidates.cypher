MATCH (contract:LspInterfaceSymbol)
WHERE contract.name CONTAINS 'Activit'
RETURN contract.id AS contractId,
       contract.name AS contractName,
       contract.uri AS uri,
       contract.startLine AS startLine,
       'name-pattern:*Activit*' AS evidence,
       0.55 AS confidence
ORDER BY uri, startLine
