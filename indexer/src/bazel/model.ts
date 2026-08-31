import { createHash } from 'node:crypto';
import path from 'node:path';
import type { CodeOrigin } from '../code-origin.js';

export interface BazelConfiguredTargetEvidence {
  label: string;
  ruleKind?: string;
  dependencies?: Array<{
    label: string;
    attribute: 'deps' | 'exports' | 'runtime_deps' | 'plugins';
  }>;
  compileArtifacts?: string[];
  runtimeArtifacts?: string[];
  directSources: Array<{ path: string; isSource: boolean }>;
  sourceJars: string[];
}

export interface BazelBuildGraphRun {
  id: string;
  buildRootId: string;
  workspacePath: string;
  configurationHash?: string;
  status: 'complete';
  targetCount: number;
  sourceCount: number;
  artifactCount: number;
  relationCount: number;
  scopeConfigHash?: string;
  scopeSelectorsJson?: string;
  resolvedTargetCount: number;
  excludedTargetCount: number;
  excludedTargetsJson: string;
}

export interface BazelTarget {
  id: string;
  graphId: string;
  buildRootId: string;
  label: string;
  ruleKind?: string;
  selected: boolean;
  codeOrigin: CodeOrigin;
}

export interface BazelSource {
  id: string;
  graphId: string;
  path: string;
  isGenerated: boolean;
  codeOrigin: CodeOrigin;
}

export interface BazelArtifact {
  id: string;
  graphId: string;
  path: string;
  codeOrigin: CodeOrigin;
}

export type BazelRelationKind =
  | 'HAS_TARGET' | 'DEPENDS_ON' | 'OWNS_SOURCE'
  | 'COMPILE_ARTIFACT' | 'RUNTIME_ARTIFACT' | 'SOURCE_ARTIFACT';

export interface BazelRelation {
  id: string;
  graphId: string;
  sourceKind: 'BazelBuildGraphRun' | 'BazelTarget';
  sourceId: string;
  targetKind: 'BazelTarget' | 'BazelSource' | 'BazelArtifact';
  targetId: string;
  kind: BazelRelationKind;
  attribute?: string;
  ordinal: number;
}

export interface BazelBuildGraphBatch {
  runs: BazelBuildGraphRun[];
  targets: BazelTarget[];
  sources: BazelSource[];
  artifacts: BazelArtifact[];
  relations: BazelRelation[];
}

export interface BazelPreparedRootGraph {
  rootId: string;
  workspacePath: string;
  configurationHash?: string;
  configuredTargets?: BazelConfiguredTargetEvidence[];
  scopeResolution?: {
    configHash: string; selectorsJson: string; resolvedLabels: string[];
    excluded: Array<{ label: string; reason: string }>;
  };
}

export function emptyBazelBuildGraphBatch(): BazelBuildGraphBatch {
  return { runs: [], targets: [], sources: [], artifacts: [], relations: [] };
}

export function buildBazelBuildGraphBatch(roots: BazelPreparedRootGraph[]): BazelBuildGraphBatch {
  const batch = emptyBazelBuildGraphBatch();
  for (const root of roots) {
    if (!root.configuredTargets) continue;
    appendRoot(batch, root);
  }
  return batch;
}

function appendRoot(batch: BazelBuildGraphBatch, root: BazelPreparedRootGraph): void {
  const graphId = stableId('bazel-graph', root.rootId, root.configurationHash ?? 'unconfigured');
  const selectedLabels = new Set(root.configuredTargets!.map((target) => target.label));
  const targetsByLabel = new Map<string, BazelTarget>();
  const sourcesByPath = new Map<string, BazelSource>();
  const artifactsByPath = new Map<string, BazelArtifact>();
  const relations: BazelRelation[] = [];

  const targetNode = (label: string, ruleKind?: string): BazelTarget => {
    const current = targetsByLabel.get(label);
    if (current) {
      if (!current.ruleKind && ruleKind) current.ruleKind = ruleKind;
      return current;
    }
    const target: BazelTarget = {
      id: stableId('bazel-target', root.rootId, label), graphId, buildRootId: root.rootId,
      label, ruleKind, selected: selectedLabels.has(label), codeOrigin: 'repository',
    };
    targetsByLabel.set(label, target);
    return target;
  };
  const sourceNode = (sourcePath: string, isGenerated: boolean): BazelSource => {
    const resolved = path.resolve(sourcePath);
    const current = sourcesByPath.get(resolved);
    if (current) return current;
    const source: BazelSource = {
      id: stableId('bazel-source', root.rootId, resolved), graphId, path: resolved, isGenerated,
      codeOrigin: isGenerated ? 'generated_first_party' : 'repository',
    };
    sourcesByPath.set(resolved, source);
    return source;
  };
  const artifactNode = (artifactPath: string): BazelArtifact => {
    const resolved = path.resolve(artifactPath);
    const current = artifactsByPath.get(resolved);
    if (current) return current;
    const artifact: BazelArtifact = {
      id: stableId('bazel-artifact', root.rootId, resolved), graphId, path: resolved,
      codeOrigin: 'first_party_artifact',
    };
    artifactsByPath.set(resolved, artifact);
    return artifact;
  };
  const relate = (
    sourceKind: BazelRelation['sourceKind'], sourceId: string,
    targetKind: BazelRelation['targetKind'], targetId: string,
    kind: BazelRelationKind, attribute: string | undefined, ordinal: number,
  ): void => {
    relations.push({
      id: stableId('bazel-relation', graphId, kind, sourceId, targetId, attribute ?? '', String(ordinal)),
      graphId, sourceKind, sourceId, targetKind, targetId, kind, attribute, ordinal,
    });
  };

  for (const configured of root.configuredTargets!) {
    const target = targetNode(configured.label, configured.ruleKind);
    relate('BazelBuildGraphRun', graphId, 'BazelTarget', target.id, 'HAS_TARGET', undefined, 0);
    for (const [ordinal, dependency] of (configured.dependencies ?? []).entries()) {
      const dependent = targetNode(dependency.label);
      relate('BazelTarget', target.id, 'BazelTarget', dependent.id, 'DEPENDS_ON', dependency.attribute, ordinal);
    }
    for (const [ordinal, sourceValue] of configured.directSources.entries()) {
      const source = sourceNode(sourceValue.path, !sourceValue.isSource);
      relate('BazelTarget', target.id, 'BazelSource', source.id, 'OWNS_SOURCE', 'srcs', ordinal);
    }
    for (const [kind, values] of [
      ['COMPILE_ARTIFACT', configured.compileArtifacts ?? []],
      ['RUNTIME_ARTIFACT', configured.runtimeArtifacts ?? []],
      ['SOURCE_ARTIFACT', configured.sourceJars],
    ] as const) {
      for (const [ordinal, artifactPath] of values.entries()) {
        const artifact = artifactNode(artifactPath);
        relate('BazelTarget', target.id, 'BazelArtifact', artifact.id, kind, undefined, ordinal);
      }
    }
  }
  batch.targets.push(...targetsByLabel.values());
  batch.sources.push(...sourcesByPath.values());
  batch.artifacts.push(...artifactsByPath.values());
  batch.relations.push(...relations);
  batch.runs.push({
    id: graphId, buildRootId: root.rootId, workspacePath: path.resolve(root.workspacePath),
    configurationHash: root.configurationHash, status: 'complete',
    targetCount: targetsByLabel.size, sourceCount: sourcesByPath.size,
    artifactCount: artifactsByPath.size, relationCount: relations.length,
    scopeConfigHash: root.scopeResolution?.configHash,
    scopeSelectorsJson: root.scopeResolution?.selectorsJson,
    resolvedTargetCount: root.scopeResolution?.resolvedLabels.length ?? selectedLabels.size,
    excludedTargetCount: root.scopeResolution?.excluded.length ?? 0,
    excludedTargetsJson: JSON.stringify(root.scopeResolution?.excluded ?? []),
  });
}

function stableId(prefix: string, ...parts: string[]): string {
  return `${prefix}:${createHash('sha256').update(parts.join('\0')).digest('hex')}`;
}
