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
    // Send requests through the logical Eclipse resource. In particular, JDT
    // on macOS does not reliably associate an external physical file URI with
    // its linked IFile and otherwise routes the document to the classpath-less
    // jdt.ls-java-project. Keep the physical alias second so server responses
    // using either URI still map back to the authoritative source.
    { sourcePath: alias.sourcePath, stagedPath: alias.logicalPath },
    { sourcePath: alias.sourcePath, stagedPath: alias.physicalPath },
  ]));
}
