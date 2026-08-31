MATCH (callerOwner:JvmClass)-[implements:JvmRelation]->(workflowContract:JvmClass),
      (callerOwner)-[declares:JvmRelation]->(caller:JvmMethod),
      (caller)-[hasSite:JvmRelation]->(site:JvmCallSite),
      (site)-[resolves:JvmRelation]->(callee:JvmMethod),
      (calleeOwner:JvmClass)-[ownsCallee:JvmRelation]->(callee),
      (callerResolution:JvmClassResolution),
      (workflowResolution:JvmClassResolution),
      (calleeResolution:JvmClassResolution)
WHERE implements.kind = 'BYTECODE_INTERFACE'
  AND declares.kind = 'DECLARES_METHOD'
  AND hasSite.kind = 'HAS_BYTECODE_CALLSITE'
  AND resolves.kind = 'BYTECODE_RESOLVES_TO'
  AND ownsCallee.kind = 'DECLARES_METHOD'
  AND callerResolution.binaryName = callerOwner.binaryName
  AND callerOwner.id = callerResolution.classId
  AND callerOwner.artifactId = callerResolution.artifactId
  AND workflowResolution.binaryName = workflowContract.binaryName
  AND workflowContract.id = workflowResolution.classId
  AND workflowContract.artifactId = workflowResolution.artifactId
  AND list_contains(workflowContract.annotations, $workflowContractType)
  AND calleeResolution.binaryName = calleeOwner.binaryName
  AND calleeOwner.id = calleeResolution.classId
  AND calleeOwner.artifactId = calleeResolution.artifactId
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
       site.bytecodeOffset AS endLine,
       0 AS endCharacter,
       callee.id AS targetId,
       callee.name AS targetName,
       calleeOwner.sourceEntry AS targetUri,
       calleeOwner.id AS targetOwnerId,
       calleeOwner.simpleName AS targetOwnerName,
       calleeOwner.packageName AS targetOwnerPackageName,
       site.bytecodeOffset AS bytecodeOffset,
       'jvm-bytecode' AS evidenceSource,
       1.0 AS confidence,
       'asm' AS providerAuthority,
       false AS isDerived,
       'resolved bytecode invocation' AS reason
ORDER BY callerUri, callerName, startLine
