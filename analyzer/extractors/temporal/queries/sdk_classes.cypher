MATCH (anchorResolution:JvmClassResolution),
      (anchor:JvmClass),
      (classResolution:JvmClassResolution),
      (class:JvmClass)
WHERE anchorResolution.binaryName = $workflowContractType
  AND anchor.id = anchorResolution.classId
  AND anchor.artifactId = anchorResolution.artifactId
  AND class.id = classResolution.classId
  AND class.artifactId = classResolution.artifactId
  AND class.binaryName STARTS WITH $sdkNamespacePrefix
RETURN class.id AS classId,
       class.artifactId AS artifactId,
       class.binaryName AS binaryName,
       class.kind AS classKind,
       class.superName AS superName,
       class.interfaces AS interfaces,
       class.sourceEntry AS sourceEntry
ORDER BY binaryName
