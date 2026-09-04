MATCH (run:JvmArtifactEnrichmentRun),
      (callerOwner:JvmClass)-[declares:JvmRelation]->(caller:JvmMethod),
      (caller)-[call:JvmCompactCall]->(target:JvmMethodReference),
      (targetClass:JvmClass)
WHERE declares.kind = 'DECLARES_METHOD'
  AND run.id = caller.stageId
  AND targetClass.binaryName = target.owner
OPTIONAL MATCH (targetClass)-[targetDeclares:JvmRelation]->(targetMethod:JvmMethod)
WHERE targetDeclares.kind = 'DECLARES_METHOD'
  AND targetMethod.name = target.name
  AND targetMethod.descriptor = target.descriptor
WITH run, callerOwner, caller, call, target, targetClass, targetMethod
WHERE $sdkOnly = false
   OR target.owner STARTS WITH $sdkNamespacePrefix
   OR list_contains(targetMethod.annotations, 'io.temporal.workflow.WorkflowMethod')
   OR list_contains(targetMethod.annotations, 'io.temporal.workflow.SignalMethod')
   OR list_contains(targetMethod.annotations, 'io.temporal.workflow.QueryMethod')
   OR list_contains(targetMethod.annotations, 'io.temporal.workflow.UpdateMethod')
RETURN DISTINCT call.id AS callSiteId, NULL AS logicalInvocationId,
       NULL AS logicalInvocationStableKey, 1 AS logicalObservationCount,
       call.confidence AS logicalConfidence, callerOwner.id AS callerOwnerId,
       callerOwner.simpleName AS callerOwnerName,
       callerOwner.packageName AS callerOwnerPackageName,
       caller.id AS callerId, caller.name AS callerName,
       callerOwner.sourceEntry AS callerUri, call.bytecodeOffset AS startLine,
       0 AS startCharacter, target.name AS requestedCallee,
       coalesce(targetMethod.id, target.signature) AS targetId, target.name AS targetName,
       targetClass.sourceEntry AS targetUri, targetClass.id AS targetOwnerId,
       targetClass.simpleName AS targetOwnerName,
       targetClass.packageName AS targetOwnerPackageName,
       target.owner AS targetJvmClass, targetClass.id AS targetJvmClassId,
       targetClass.artifactId AS targetArtifactId, call.bytecodeOffset AS bytecodeOffset,
       run.provider AS evidenceSource,
       CASE
         WHEN list_contains(targetMethod.annotations, 'io.temporal.workflow.WorkflowMethod') THEN 'workflow'
         WHEN list_contains(targetMethod.annotations, 'io.temporal.workflow.SignalMethod') THEN 'signal'
         WHEN list_contains(targetMethod.annotations, 'io.temporal.workflow.QueryMethod') THEN 'query'
         WHEN list_contains(targetMethod.annotations, 'io.temporal.workflow.UpdateMethod') THEN 'update'
         ELSE 'sdk'
       END AS targetRole,
       call.confidence AS confidence, run.provider AS providerAuthority,
       false AS isDerived, call.evidence AS reason
ORDER BY callerUri, callerName, startLine
