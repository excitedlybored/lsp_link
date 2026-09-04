MATCH (owner:JvmClass)-[declares:JvmRelation]->(method:JvmMethod)
WHERE declares.kind = 'DECLARES_METHOD' AND list_contains(method.annotations, $listenerType)
RETURN DISTINCT method.id AS evidenceId, owner.id AS ownerId,
       owner.packageName AS packageName, owner.simpleName AS ownerName,
       method.id AS methodId, method.name AS methodName, method.descriptor AS descriptor,
       method.annotationValuesJson AS annotationValuesJson,
       owner.sourceEntry AS uri, 1.0 AS confidence
ORDER BY packageName, ownerName, methodName
