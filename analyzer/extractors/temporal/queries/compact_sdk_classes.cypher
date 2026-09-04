MATCH (type:JvmClass)
WHERE type.binaryName STARTS WITH $sdkNamespacePrefix
RETURN DISTINCT type.id AS classId, type.binaryName AS binaryName,
       type.artifactId AS artifactId, type.sourceEntry AS sourceEntry
ORDER BY binaryName
