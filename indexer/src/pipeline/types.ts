import type { NormalizedArtifactDescriptor, ArtifactClasspathProviderAttempt } from '../artifact/classpath/index.js';
import type { JvmArtifactEnrichmentSummary } from '../artifact/model.js';
import type { LspObservationBatch } from '../ingest/batch.js';
import type { DerivedCallNormalizationBatch } from '../derived/call-normalization/model.js';
import type { CrawlProfile } from '../ingest/crawl-profile.js';
import type { BazelBuildMode, BazelTargetScope } from '../../../lsp_server/public-api.js';
import type { BazelScopeResolution } from '../../../lsp_server/public-api.js';
import type {
  BazelCrawlSource,
  BazelSourceInventoryComparison,
} from '../../../lsp_server/public-api.js';
import type { BazelConfiguredTargetEvidence } from '../bazel/model.js';
import type { BazelBuildGraphBatch } from '../bazel/model.js';
import type { RepositoryInventoryBatch } from '../repository/model.js';

export interface LspKnowledgeGraphBuildOptions {
  workspace: string;
  output: string;
  concurrency: number;
  jdtProcesses: number;
  artifactMaxClasses?: number;
  artifactConcurrency: number;
  artifactAnalyzer: 'asm' | 'sootup';
  artifactProjection: 'legacy' | 'compact';
  artifactExternalBodies: 'none' | 'all';
  configurationSources: Array<'spring' | 'kubernetes' | 'helm'>;
  activeProfiles: string[];
  helmValuesFiles: string[];
  fetchArtifactSources: boolean;
  artifactManifestPaths: string[];
  checkpointDirectory: string;
  resume: boolean;
  crawlProfile: CrawlProfile;
  javaSemantics: 'batch' | 'lsp';
  bazelBuildMode: BazelBuildMode;
  bazelTargetQuery?: string;
  bazelTargetScope?: BazelTargetScope;
  runConfigPath?: string;
  runConfigHash?: string;
  bazelPreparationConcurrency?: number;
  bazelPreparationTimeoutMs?: number;
  failOnFailedBuildRoot: boolean;
}

export interface LspKnowledgeGraphBuildResult {
  batch: LspObservationBatch;
  artifactEnrichment: JvmArtifactEnrichmentSummary;
  callNormalizationBatch: DerivedCallNormalizationBatch;
  output: string;
  bazelBuildGraph: BazelBuildGraphBatch;
  repositoryInventory: RepositoryInventoryBatch;
}

export interface LspRepositoryCrawlResult {
  batch: LspObservationBatch;
  artifacts: NormalizedArtifactDescriptor[];
  classpathAttempts: ArtifactClasspathProviderAttempt[];
  checkpoint: string;
  crawlFingerprint: string;
  durationMs: number;
  peakNodeRssMiB: number;
  repositoryInventory: RepositoryInventoryBatch;
}

export interface JavaBuildRootPreparation {
  status: string;
  configurationHash?: string;
  reason?: string;
  modelPath?: string;
  sourceInventoryPath?: string;
  sourceInventoryHash?: string;
  crawlSources?: BazelCrawlSource[];
  sourceInventoryComparison?: BazelSourceInventoryComparison;
  configuredTargets?: BazelConfiguredTargetEvidence[];
  rootId: string;
  workspacePath?: string;
  scopeResolution?: BazelScopeResolution;
}

export interface JavaBuildRootCrawlResult {
  batch: LspObservationBatch;
  artifacts: NormalizedArtifactDescriptor[];
  artifactClasspathAttempts: ArtifactClasspathProviderAttempt[];
  failed: boolean;
  errorCount: number;
  timeoutCount: number;
}
