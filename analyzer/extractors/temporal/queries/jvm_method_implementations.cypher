MATCH (implementationClass:JvmClass)-[interfaceRelation:JvmRelation]->(contractClass:JvmClass),
      (implementationClass)-[declaresImplementation:JvmRelation]->(implementation:JvmMethod),
      (contractClass)-[declaresContract:JvmRelation]->(contract:JvmMethod),
      (implementationResolution:JvmClassResolution),
      (contractResolution:JvmClassResolution)
WHERE interfaceRelation.kind = 'BYTECODE_INTERFACE'
  AND declaresImplementation.kind = 'DECLARES_METHOD'
  AND declaresContract.kind = 'DECLARES_METHOD'
  AND implementation.name = contract.name
  AND implementation.descriptor = contract.descriptor
  AND implementationResolution.binaryName = implementationClass.binaryName
  AND implementationClass.id = implementationResolution.classId
  AND implementationClass.artifactId = implementationResolution.artifactId
  AND contractResolution.binaryName = contractClass.binaryName
  AND contractClass.id = contractResolution.classId
  AND contractClass.artifactId = contractResolution.artifactId
  AND (
    list_contains(contractClass.annotations, $workflowContractType)
    OR list_contains(contractClass.annotations, $activityContractType)
  )
RETURN DISTINCT implementation.id AS implementationMethodId,
       implementation.name AS implementationMethodName,
       implementation.descriptor AS implementationSignature,
       implementationClass.simpleName AS implementationOwnerName,
       implementationClass.packageName AS implementationPackageName,
       implementationClass.sourceEntry AS implementationUri,
       contract.id AS contractMethodId,
       contract.name AS contractMethodName,
       interfaceRelation.id AS evidenceId,
       1.0 AS confidence
ORDER BY implementationPackageName, implementationOwnerName,
         implementationMethodName, implementationSignature
