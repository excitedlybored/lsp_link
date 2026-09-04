MATCH (owner:JvmClass)-[declares:JvmRelation]->(caller:JvmMethod),
      (caller)-[hasSite:JvmRelation]->(site:JvmCallSite)
WHERE declares.kind = 'DECLARES_METHOD' AND hasSite.kind = 'HAS_BYTECODE_CALLSITE'
  AND site.targetOwner = $producerType AND site.targetName = 'send'
RETURN DISTINCT site.id AS evidenceId, owner.id AS ownerId,
       owner.packageName AS packageName, owner.simpleName AS ownerName,
       caller.id AS methodId, caller.name AS methodName, caller.descriptor AS descriptor,
       owner.sourceEntry AS uri, site.bytecodeOffset AS offset,
       site.targetOwner AS targetOwner, site.targetName AS operation,
       1.0 AS confidence, 'asm' AS provider
ORDER BY packageName, ownerName, methodName, offset
