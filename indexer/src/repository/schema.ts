export const REPOSITORY_INVENTORY_SCHEMA_QUERIES = [
  `CREATE NODE TABLE RepositoryInventoryRun (
    id STRING, workspacePath STRING, status STRING, documentCount INT64,
    declarationCount INT64, PRIMARY KEY (id))`,
  `CREATE NODE TABLE RepositoryProviderRun (
    id STRING, runId STRING, providerId STRING, providerVersion STRING,
    authority STRING, languages STRING[], capabilities STRING[], includeGlobs STRING[], status STRING,
    discoveredCount INT64, indexedCount INT64, skippedCount INT64,
    errorCount INT64, errorsJson STRING, PRIMARY KEY (id))`,
  `CREATE NODE TABLE RepositoryDocument (
    id STRING, runId STRING, path STRING, relativePath STRING, languageId STRING,
    kind STRING, contentHash STRING, byteSize INT64, lineCount INT64,
    codeOrigin STRING, providerId STRING, providerVersion STRING, authority STRING,
    PRIMARY KEY (id))`,
  `CREATE NODE TABLE RepositoryDeclaration (
    id STRING, runId STRING, documentId STRING, kind STRING, name STRING,
    startLine INT64, startCharacter INT64, endLine INT64, endCharacter INT64,
    providerId STRING, providerVersion STRING, authority STRING,
    codeOrigin STRING, PRIMARY KEY (id))`,
  `CREATE NODE TABLE ConfigurationKey (
    id STRING, name STRING, PRIMARY KEY (id))`,
  `CREATE NODE TABLE ConfigurationValue (
    id STRING, documentId STRING, keyId STRING, key STRING, rawValue STRING,
    resolvedValue STRING, status STRING, sourceKind STRING, scope STRING, profileName STRING,
    precedence INT32, confidence DOUBLE, startLine INT64, startCharacter INT64,
    PRIMARY KEY (id))`,
  `CREATE NODE TABLE ConfigurationReference (
    id STRING, valueId STRING, targetKeyId STRING, targetKey STRING,
    kind STRING, status STRING, PRIMARY KEY (id))`,
  `CREATE NODE TABLE DeploymentUnit (
    id STRING, documentId STRING, kind STRING, name STRING, namespace STRING,
    PRIMARY KEY (id))`,
  `CREATE REL TABLE RepositoryInventoryRelation (
    FROM RepositoryInventoryRun TO RepositoryDocument,
    FROM RepositoryInventoryRun TO RepositoryProviderRun,
    FROM RepositoryProviderRun TO RepositoryDocument,
    FROM RepositoryDocument TO RepositoryDeclaration,
    FROM RepositoryDocument TO ConfigurationValue,
    FROM ConfigurationValue TO ConfigurationKey,
    FROM ConfigurationValue TO ConfigurationReference,
    FROM ConfigurationReference TO ConfigurationKey,
    FROM RepositoryDocument TO DeploymentUnit,
    kind STRING)`,
] as const;
