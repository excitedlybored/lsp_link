MATCH (caller)-[hasSite:LspRelation]->(site:LspCallSite),
      (site)-[resolves:LspRelation]->(callee)
WHERE hasSite.kind = 'HAS_CALLSITE'
  AND resolves.kind = 'RESOLVES_TO'
  AND (
    callee.uri CONTAINS 'io.temporal'
    OR callee.uri CONTAINS 'temporal-sdk'
    OR site.calleeName CONTAINS 'newWorkflowStub'
    OR site.calleeName CONTAINS 'newActivityStub'
    OR site.calleeName CONTAINS 'newLocalActivityStub'
    OR site.calleeName CONTAINS 'registerWorkflowImplementationTypes'
    OR site.calleeName CONTAINS 'registerActivitiesImplementations'
    OR site.calleeName CONTAINS 'signalWithStart'
  )
RETURN DISTINCT site.id AS callSiteId,
       caller.id AS callerId,
       caller.name AS callerName,
       caller.uri AS callerUri,
       site.startLine AS startLine,
       site.startCharacter AS startCharacter,
       site.calleeName AS requestedCallee,
       callee.id AS targetId,
       callee.name AS targetName,
       callee.uri AS targetUri,
       resolves.mappingConfidence AS confidence,
       resolves.providerAuthority AS providerAuthority
ORDER BY callerUri, startLine, startCharacter
