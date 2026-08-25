export const JVM_ARTIFACT_SCHEMA_QUERIES = [
  `CREATE NODE TABLE JvmArtifactEnrichmentRun (
    id STRING, lspRunId STRING, status STRING, startedAt STRING, completedAt STRING,
    provider STRING, providerVersion STRING, classpathProviders STRING[],
    classpathResolutionJson STRING, classpathErrorCount INT64, artifactCount INT64, classCount INT64,
    methodCount INT64, fieldCount INT64, callSiteCount INT64, errorCount INT64,
    truncated BOOLEAN, PRIMARY KEY (id))`,
  `CREATE NODE TABLE JvmArtifact (
    id STRING, stageId STRING, buildRootIds STRING[], classpathProviders STRING[],
    classpathScopes STRING[], modulePath BOOLEAN, coordinate STRING,
    classpathEntryPath STRING, headerJarPath STRING, binaryJarPath STRING, sourceJarPath STRING,
    sourceOrigin STRING, associationStatus STRING, classCount INT64, PRIMARY KEY (id))`,
  `CREATE NODE TABLE JvmClass (
    id STRING, stageId STRING, artifactId STRING, binaryName STRING,
    packageName STRING, simpleName STRING, kind STRING, access STRING,
    superName STRING, interfaces STRING[], sourceEntry STRING, isSeed BOOLEAN,
    seedUris STRING[], wasDisassembled BOOLEAN, PRIMARY KEY (id))`,
  `CREATE NODE TABLE JvmMethod (
    id STRING, stageId STRING, classId STRING, owner STRING, name STRING,
    descriptor STRING, declaration STRING, access STRING, hasCode BOOLEAN,
    isExternalPlaceholder BOOLEAN, PRIMARY KEY (id))`,
  `CREATE NODE TABLE JvmField (
    id STRING, stageId STRING, classId STRING, owner STRING, name STRING,
    descriptor STRING, declaration STRING, access STRING, PRIMARY KEY (id))`,
  `CREATE NODE TABLE JvmCallSite (
    id STRING, stageId STRING, callerMethodId STRING, bytecodeOffset INT64,
    opcode STRING, targetOwner STRING, targetName STRING,
    targetDescriptor STRING, status STRING, PRIMARY KEY (id))`,
  `CREATE REL TABLE JvmRelation (
    FROM JvmArtifactEnrichmentRun TO JvmArtifact,
    FROM JvmArtifact TO JvmClass,
    FROM JvmClass TO JvmMethod,
    FROM JvmClass TO JvmField,
    FROM JvmClass TO JvmClass,
    FROM JvmMethod TO JvmCallSite,
    FROM JvmCallSite TO JvmMethod,
    id STRING, kind STRING, stageId STRING, status STRING, ordinal INT32)`,
] as const;
