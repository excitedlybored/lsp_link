import type { NormalizedArtifactDescriptor, ArtifactClasspathProviderAttempt } from '../artifact/classpath/index.js';
import type { JvmArtifactBatch } from '../artifact/model.js';
import type { LspObservationBatch } from '../ingest/batch.js';
import type { DerivedCallNormalizationBatch } from '../derived/call-normalization/model.js';
import type {
  BazelCrawlSource,
  BazelSourceInventoryComparison,
} from '../../../lsp_server/adapters/java/bazel-source-inventory.js';

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
}

export interface LspKnowledgeGraphBuildResult {
  batch: LspObservationBatch;
  artifactBatch: JvmArtifactBatch;
  callNormalizationBatch: DerivedCallNormalizationBatch;
  output: string;
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
}

export interface JavaBuildRootCrawlResult {
  batch: LspObservationBatch;
  artifacts: NormalizedArtifactDescriptor[];
  artifactClasspathAttempts: ArtifactClasspathProviderAttempt[];
  failed: boolean;
  errorCount: number;
  timeoutCount: number;
}
