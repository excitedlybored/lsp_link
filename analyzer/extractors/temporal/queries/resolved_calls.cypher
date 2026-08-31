MATCH (callerOwner)-[ownsCaller:LspRelation]->(caller:LspMethodSymbol),
      (caller)-[hasSite:LspRelation]->(site:LspCallSite),
      (site)-[resolves:LspRelation]->(callee)
WHERE ownsCaller.kind = 'CONTAINS'
  AND hasSite.kind = 'HAS_CALLSITE'
  AND resolves.kind = 'RESOLVES_TO'
OPTIONAL MATCH (site)-[normalizes:DerivedCallRelation]->(logical:LspLogicalInvocation)
WHERE normalizes.kind = 'NORMALIZES_TO'
OPTIONAL MATCH (calleeOwner)-[ownsCallee:LspRelation]->(callee)
WHERE ownsCallee.kind = 'CONTAINS'
RETURN DISTINCT site.id AS callSiteId,
       logical.id AS logicalInvocationId,
       logical.stableKey AS logicalInvocationStableKey,
       logical.observationCount AS logicalObservationCount,
       logical.confidence AS logicalConfidence,
       callerOwner.id AS callerOwnerId,
       callerOwner.name AS callerOwnerName,
       NULL AS callerOwnerPackageName,
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
       NULL AS targetOwnerPackageName,
       NULL AS bytecodeOffset,
       'lsp' AS evidenceSource,
       resolves.mappingConfidence AS confidence,
       resolves.providerAuthority AS providerAuthority,
       resolves.isDerived AS isDerived,
       resolves.reason AS reason
ORDER BY callerUri, startLine, startCharacter
