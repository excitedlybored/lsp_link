MATCH (caller)-[hasSite:LspRelation]->(site:LspCallSite),
      (site)-[resolves:LspRelation]->(callee),
      (callee)-[binding:LspJvmBinding]->(targetClass:JvmClass),
      (workflowClientType:JvmClass),
      (serviceClientType:JvmClass)
WHERE hasSite.kind = 'HAS_CALLSITE'
  AND resolves.kind = 'RESOLVES_TO'
  AND binding.kind = 'SYMBOL_OWNER'
  AND workflowClientType.binaryName = $workflowClientType
  AND serviceClientType.binaryName = $serviceClientType
  AND (
    targetClass.artifactId = workflowClientType.artifactId
    OR targetClass.artifactId = serviceClientType.artifactId
  )
OPTIONAL MATCH (site)-[normalizes:DerivedCallRelation]->(logical:LspLogicalInvocation)
WHERE normalizes.kind = 'NORMALIZES_TO'
RETURN DISTINCT site.id AS callSiteId,
       logical.id AS logicalInvocationId,
       logical.stableKey AS logicalInvocationStableKey,
       logical.observationCount AS logicalObservationCount,
       logical.confidence AS logicalConfidence,
       caller.id AS callerId,
       caller.name AS callerName,
       caller.uri AS callerUri,
       site.startLine AS startLine,
       site.startCharacter AS startCharacter,
       site.calleeName AS requestedCallee,
       callee.id AS targetId,
       callee.name AS targetName,
       callee.uri AS targetUri,
       targetClass.id AS targetJvmClassId,
       targetClass.binaryName AS targetJvmClass,
       targetClass.artifactId AS targetArtifactId,
       resolves.mappingConfidence AS confidence,
       resolves.providerAuthority AS providerAuthority
ORDER BY callerUri, startLine, startCharacter
