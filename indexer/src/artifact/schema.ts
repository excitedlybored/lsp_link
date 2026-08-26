import { LSP_SYMBOL_NODE_TABLES } from '../model.js';

const LSP_JVM_BINDING_SOURCES = ['LspHover', 'LspOccurrence', ...LSP_SYMBOL_NODE_TABLES];
const LSP_JVM_BINDING_ENDPOINTS = LSP_JVM_BINDING_SOURCES.flatMap((source) => [
  `    FROM ${source} TO JvmClass`,
  `    FROM ${source} TO JvmMethod`,
]).join(',\n');

export const JVM_ARTIFACT_SCHEMA_QUERIES = [
  `CREATE NODE TABLE JvmArtifactEnrichmentRun (
    id STRING, lspRunId STRING, status STRING, startedAt STRING, completedAt STRING,
    provider STRING, providerVersion STRING, classpathProviders STRING[] DEFAULT [],
    classpathResolutionJson STRING, classpathErrorCount INT64, artifactCount INT64, classCount INT64,
    methodCount INT64, fieldCount INT64, callSiteCount INT64, errorCount INT64,
    truncated BOOLEAN, PRIMARY KEY (id))`,
  `CREATE NODE TABLE JvmArtifact (
    id STRING, stageId STRING, buildRootIds STRING[] DEFAULT [], classpathProviders STRING[] DEFAULT [],
    classpathScopes STRING[] DEFAULT [], modulePath BOOLEAN, coordinate STRING,
    classpathEntryPath STRING, headerJarPath STRING, binaryJarPath STRING, sourceJarPath STRING,
    sourceOrigin STRING, associationStatus STRING, classCount INT64, methodCount INT64,
    fieldCount INT64, callSiteCount INT64, contentHash STRING,
    classpathOrdinal INT32, processingStatus STRING, errorCount INT64, completedAt STRING,
    PRIMARY KEY (id))`,
  `CREATE NODE TABLE JvmClassResolution (
    binaryName STRING, stageId STRING, classId STRING, artifactId STRING,
    classpathOrdinal INT32, PRIMARY KEY (binaryName))`,
  `CREATE NODE TABLE JvmBinaryReference (
    binaryName STRING, stageId STRING, PRIMARY KEY (binaryName))`,
  `CREATE NODE TABLE JvmClass (
    id STRING, stageId STRING, artifactId STRING, binaryName STRING,
    packageName STRING, simpleName STRING, kind STRING, access STRING,
    superName STRING, interfaces STRING[] DEFAULT [], sourceEntry STRING, isSeed BOOLEAN,
    seedUris STRING[] DEFAULT [], wasDisassembled BOOLEAN, annotations STRING[] DEFAULT [], PRIMARY KEY (id))`,
  `CREATE NODE TABLE JvmMethod (
    id STRING, stageId STRING, classId STRING, owner STRING, name STRING,
    descriptor STRING, declaration STRING, access STRING, hasCode BOOLEAN,
    isExternalPlaceholder BOOLEAN, annotations STRING[] DEFAULT [], PRIMARY KEY (id))`,
  `CREATE NODE TABLE JvmField (
    id STRING, stageId STRING, classId STRING, owner STRING, name STRING,
    descriptor STRING, declaration STRING, access STRING, annotations STRING[] DEFAULT [], PRIMARY KEY (id))`,
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
  `CREATE REL TABLE JvmBinaryReferenceRelation (
    FROM JvmBinaryReference TO JvmClass,
    FROM JvmBinaryReference TO JvmCallSite,
    id STRING, kind STRING, stageId STRING, ordinal INT32)`,
  `CREATE REL TABLE JvmResolvedReference (
    FROM JvmClass TO JvmBinaryReference,
    id STRING, stageId STRING)`,
  `CREATE REL TABLE LspJvmBinding (
${LSP_JVM_BINDING_ENDPOINTS},
    id STRING, kind STRING, stageId STRING, status STRING,
    confidence DOUBLE, reason STRING)`,
] as const;
