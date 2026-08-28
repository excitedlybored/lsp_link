import type { NormalizedArtifactDescriptor, ArtifactClasspathProviderAttempt } from '../artifact/classpath/index.js';
import type { JvmArtifactEnrichmentSummary } from '../artifact/model.js';
import type { LspObservationBatch } from '../ingest/batch.js';
import type { DerivedCallNormalizationBatch } from '../derived/call-normalization/model.js';
import type { CrawlPlannerMode } from '../ingest/crawl-planner.js';
import type { CrawlProfile } from '../ingest/crawl-profile.js';
import type { BazelBuildMode, BazelTargetScope } from '../../../lsp_server/adapters/java/bazel-project-model.js';
import type { BazelScopeResolution } from '../../../lsp_server/adapters/java/bazel-project-model.js';
import type {
  BazelCrawlSource,
  BazelSourceInventoryComparison,
} from '../../../lsp_server/adapters/java/bazel-source-inventory.js';
import type { BazelConfiguredTargetEvidence } from '../bazel/model.js';
import type { BazelBuildGraphBatch } from '../bazel/model.js';

export interface LspKnowledgeGraphBuildOptions {
  workspace: string;
  output: string;
  concurrency: number;
  artifactMaxClasses?: number;
  artifactConcurrency: number;
  fetchArtifactSources: boolean;
  artifactManifestPaths: string[];
  checkpointDirectory: string;
  resume: boolean;
  crawlPlanner: CrawlPlannerMode;
  crawlProfile: CrawlProfile;
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
