import type { NormalizedArtifactDescriptor, ArtifactClasspathProviderAttempt } from '../artifact/classpath/index.js';
import type { JvmArtifactBatch } from '../artifact/model.js';
import type { LspObservationBatch } from '../ingest/batch.js';

export interface LspKnowledgeGraphBuildOptions {
  workspace: string;
  output: string;
  concurrency: number;
  artifactMaxClasses?: number;
  fetchArtifactSources: boolean;
  artifactManifestPaths: string[];
}

export interface LspKnowledgeGraphBuildResult {
  batch: LspObservationBatch;
  artifactBatch: JvmArtifactBatch;
  output: string;
}

export interface JavaBuildRootPreparation {
  status: string;
  configurationHash?: string;
  reason?: string;
  modelPath?: string;
}

export interface JavaBuildRootCrawlResult {
  batch: LspObservationBatch;
  artifacts: NormalizedArtifactDescriptor[];
  artifactClasspathAttempts: ArtifactClasspathProviderAttempt[];
  failed: boolean;
  errorCount: number;
  timeoutCount: number;
}
