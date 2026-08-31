MATCH (callerOwner:JvmClass)-[declares:JvmRelation]->(caller:JvmMethod),
      (caller)-[hasSite:JvmRelation]->(site:JvmCallSite),
      (site)-[resolves:JvmRelation]->(callee:JvmMethod),
      (targetClass:JvmClass)-[ownsTarget:JvmRelation]->(callee),
      (callerResolution:JvmClassResolution),
      (targetResolution:JvmClassResolution)
WHERE declares.kind = 'DECLARES_METHOD'
  AND hasSite.kind = 'HAS_BYTECODE_CALLSITE'
  AND resolves.kind = 'BYTECODE_RESOLVES_TO'
  AND ownsTarget.kind = 'DECLARES_METHOD'
  AND callerResolution.binaryName = callerOwner.binaryName
  AND callerOwner.id = callerResolution.classId
  AND callerOwner.artifactId = callerResolution.artifactId
  AND targetResolution.binaryName = targetClass.binaryName
  AND targetClass.id = targetResolution.classId
  AND targetClass.artifactId = targetResolution.artifactId
  AND (
    targetClass.binaryName STARTS WITH $sdkNamespacePrefix
    OR list_contains(callee.annotations, $workflowEntryPointType)
    OR list_contains(callee.annotations, $signalEntryPointType)
    OR list_contains(callee.annotations, $queryEntryPointType)
    OR list_contains(callee.annotations, $updateEntryPointType)
  )
RETURN DISTINCT site.id AS callSiteId,
       NULL AS logicalInvocationId,
       NULL AS logicalInvocationStableKey,
       1 AS logicalObservationCount,
       1.0 AS logicalConfidence,
       callerOwner.id AS callerOwnerId,
       callerOwner.simpleName AS callerOwnerName,
       callerOwner.packageName AS callerOwnerPackageName,
       caller.id AS callerId,
       caller.name AS callerName,
       callerOwner.sourceEntry AS callerUri,
       site.bytecodeOffset AS startLine,
       0 AS startCharacter,
       site.targetName AS requestedCallee,
       callee.id AS targetId,
       callee.name AS targetName,
       targetClass.sourceEntry AS targetUri,
       targetClass.id AS targetJvmClassId,
       targetClass.binaryName AS targetJvmClass,
       targetClass.id AS targetOwnerId,
       targetClass.simpleName AS targetOwnerName,
       targetClass.packageName AS targetOwnerPackageName,
       targetClass.artifactId AS targetArtifactId,
       site.bytecodeOffset AS bytecodeOffset,
       'jvm-bytecode' AS evidenceSource,
       CASE
         WHEN list_contains(callee.annotations, $workflowEntryPointType) THEN 'workflow'
         WHEN list_contains(callee.annotations, $signalEntryPointType) THEN 'signal'
         WHEN list_contains(callee.annotations, $queryEntryPointType) THEN 'query'
         WHEN list_contains(callee.annotations, $updateEntryPointType) THEN 'update'
         ELSE 'sdk'
       END AS targetRole,
       1.0 AS confidence,
       'asm' AS providerAuthority
ORDER BY callerUri, callerName, startLine
