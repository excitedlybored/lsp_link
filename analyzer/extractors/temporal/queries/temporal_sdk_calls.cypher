MATCH (caller)-[hasSite:LspRelation]->(site:LspCallSite),
      (site)-[resolves:LspRelation]->(callee),
      (callee)-[binding:LspJvmBinding]->(targetClass:JvmClass),
      (targetResolution:JvmClassResolution),
      (workflowClientResolution:JvmClassResolution),
      (workflowClientType:JvmClass),
      (serviceClientResolution:JvmClassResolution),
      (serviceClientType:JvmClass)
WHERE hasSite.kind = 'HAS_CALLSITE'
  AND resolves.kind = 'RESOLVES_TO'
  AND binding.kind = 'SYMBOL_OWNER'
  AND workflowClientResolution.binaryName = $workflowClientType
  AND workflowClientType.id = workflowClientResolution.classId
  AND workflowClientType.artifactId = workflowClientResolution.artifactId
  AND serviceClientResolution.binaryName = $serviceClientType
  AND serviceClientType.id = serviceClientResolution.classId
  AND serviceClientType.artifactId = serviceClientResolution.artifactId
  AND targetResolution.binaryName = targetClass.binaryName
  AND targetClass.id = targetResolution.classId
  AND targetClass.artifactId = targetResolution.artifactId
  AND targetClass.binaryName STARTS WITH $sdkNamespacePrefix
OPTIONAL MATCH (callerOwner)-[ownsCaller:LspRelation]->(caller)
WHERE ownsCaller.kind = 'CONTAINS'
OPTIONAL MATCH (site)-[normalizes:DerivedCallRelation]->(logical:LspLogicalInvocation)
WHERE normalizes.kind = 'NORMALIZES_TO'
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
       site.calleeName AS requestedCallee,
       callee.id AS targetId,
       callee.name AS targetName,
       callee.uri AS targetUri,
       targetClass.id AS targetJvmClassId,
       targetClass.binaryName AS targetJvmClass,
       targetClass.id AS targetOwnerId,
       targetClass.simpleName AS targetOwnerName,
       targetClass.packageName AS targetOwnerPackageName,
       targetClass.artifactId AS targetArtifactId,
       NULL AS bytecodeOffset,
       'lsp' AS evidenceSource,
       resolves.mappingConfidence AS confidence,
       resolves.providerAuthority AS providerAuthority
ORDER BY callerUri, startLine, startCharacter
