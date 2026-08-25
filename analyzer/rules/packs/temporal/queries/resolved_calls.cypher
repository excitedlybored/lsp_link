MATCH (callerOwner)-[ownsCaller:LspRelation]->(caller:LspMethodSymbol),
      (caller)-[hasSite:LspRelation]->(site:LspCallSite),
      (site)-[resolves:LspRelation]->(callee)
WHERE ownsCaller.kind = 'CONTAINS'
  AND hasSite.kind = 'HAS_CALLSITE'
  AND resolves.kind = 'RESOLVES_TO'
OPTIONAL MATCH (calleeOwner)-[ownsCallee:LspRelation]->(callee)
WHERE ownsCallee.kind = 'CONTAINS'
RETURN DISTINCT site.id AS callSiteId,
       callerOwner.id AS callerOwnerId,
       callerOwner.name AS callerOwnerName,
       caller.id AS callerId,
       caller.name AS callerName,
       caller.uri AS callerUri,
       site.startLine AS startLine,
       site.startCharacter AS startCharacter,
       site.endLine AS endLine,
       site.endCharacter AS endCharacter,
       callee.id AS targetId,
       callee.name AS targetName,
       callee.uri AS targetUri,
       calleeOwner.id AS targetOwnerId,
       calleeOwner.name AS targetOwnerName,
       resolves.mappingConfidence AS confidence,
       resolves.providerAuthority AS providerAuthority,
       resolves.isDerived AS isDerived,
       resolves.reason AS reason
ORDER BY callerUri, startLine, startCharacter
