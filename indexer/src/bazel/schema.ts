export const BAZEL_BUILD_GRAPH_SCHEMA_QUERIES = [
  `CREATE NODE TABLE BazelBuildGraphRun (
    id STRING, buildRootId STRING, workspacePath STRING, configurationHash STRING,
    status STRING, targetCount INT64, sourceCount INT64, artifactCount INT64,
    relationCount INT64, scopeConfigHash STRING, scopeSelectorsJson STRING,
    resolvedTargetCount INT64, excludedTargetCount INT64, excludedTargetsJson STRING,
    PRIMARY KEY (id))`,
  `CREATE NODE TABLE BazelTarget (
    id STRING, graphId STRING, buildRootId STRING, label STRING, ruleKind STRING,
    selected BOOLEAN, codeOrigin STRING, PRIMARY KEY (id))`,
  `CREATE NODE TABLE BazelSource (
    id STRING, graphId STRING, path STRING, isGenerated BOOLEAN, codeOrigin STRING, PRIMARY KEY (id))`,
  `CREATE NODE TABLE BazelArtifact (
    id STRING, graphId STRING, path STRING, codeOrigin STRING, PRIMARY KEY (id))`,
  `CREATE REL TABLE BazelRelation (
    FROM BazelBuildGraphRun TO BazelTarget,
    FROM BazelTarget TO BazelTarget,
    FROM BazelTarget TO BazelSource,
    FROM BazelTarget TO BazelArtifact,
    id STRING, graphId STRING, kind STRING, attribute STRING, ordinal INT32)`,
] as const;
