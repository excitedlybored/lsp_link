MATCH (class:JvmClass)
WHERE class.binaryName STARTS WITH 'io.temporal.'
RETURN class.id AS classId,
       class.artifactId AS artifactId,
       class.binaryName AS binaryName,
       class.kind AS classKind,
       class.superName AS superName,
       class.interfaces AS interfaces,
       class.sourceEntry AS sourceEntry
ORDER BY binaryName
