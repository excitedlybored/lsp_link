MATCH (run:JvmArtifactEnrichmentRun),
      (owner:JvmClass)-[declares:JvmRelation]->(caller:JvmMethod),
      (caller)-[call:JvmCompactCall]->(target:JvmMethodReference)
WHERE declares.kind = 'DECLARES_METHOD'
  AND run.id = caller.stageId
  AND target.owner = $producerType AND target.name = 'send'
RETURN DISTINCT call.id AS evidenceId, owner.id AS ownerId,
       owner.packageName AS packageName, owner.simpleName AS ownerName,
       caller.id AS methodId, caller.name AS methodName, caller.descriptor AS descriptor,
       owner.sourceEntry AS uri, call.bytecodeOffset AS offset,
       target.owner AS targetOwner, target.name AS operation,
       call.confidence AS confidence, run.provider AS provider
ORDER BY packageName, ownerName, methodName, offset
