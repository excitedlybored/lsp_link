import type { PreparedJdtlsShard } from './jdtls-sharding.js';

export interface JdtlsUriMapping {
  sourcePath: string;
  stagedPath: string;
}

/** Build physical and logical document aliases once per prepared JDT shard. */
export function buildJdtlsShardUriMappings(
  shard: PreparedJdtlsShard,
  projectModels = shard.projectModels,
): JdtlsUriMapping[] {
  return projectModels.flatMap((model) => model.uriAliases.flatMap((alias) => [
    { sourcePath: alias.sourcePath, stagedPath: alias.physicalPath },
    { sourcePath: alias.sourcePath, stagedPath: alias.logicalPath },
  ]));
}
