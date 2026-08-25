import { mergeArtifactDescriptors } from './descriptor-normalizer.js';
import { loadJdtRuntimeClasspath } from './jdt-runtime-classpath.js';
import { createDefaultArtifactClasspathProviders, JdtLsClasspathProvider } from './providers.js';
import type {
  ArtifactClasspathProvider,
  ArtifactClasspathProviderAttempt,
  ArtifactClasspathProviderContext,
  ArtifactClasspathProviderId,
  ArtifactClasspathResolution,
  ArtifactClasspathResolutionContext,
  NormalizedArtifactDescriptor,
  ResolvedClasspathEntry,
} from './types.js';

export class ArtifactClasspathResolver {
  constructor(private readonly providers: ArtifactClasspathProvider[] = createDefaultArtifactClasspathProviders()) {}

  async resolveArtifacts(context: ArtifactClasspathResolutionContext): Promise<ArtifactClasspathResolution> {
    let jdtClasspathPromise: Promise<ResolvedClasspathEntry[]> | undefined;
    const providerContext: ArtifactClasspathProviderContext = {
      ...context,
      loadJdtRuntimeClasspath: () => jdtClasspathPromise ??= loadJdtRuntimeClasspath(context),
    };
    const artifacts: NormalizedArtifactDescriptor[] = [];
    const attempts: ArtifactClasspathProviderAttempt[] = [];
    for (const provider of this.providers) {
      if (!provider.supports(context)) continue;
      await this.resolveWithProvider(provider, providerContext, artifacts, attempts);
    }
    if (artifacts.length === 0 && context.lspClient) {
      await this.resolveWithProvider(new JdtLsClasspathProvider(), providerContext, artifacts, attempts);
    }
    return { artifacts: mergeArtifactDescriptors(artifacts), attempts };
  }

  private async resolveWithProvider(
    provider: ArtifactClasspathProvider,
    context: ArtifactClasspathProviderContext,
    artifacts: NormalizedArtifactDescriptor[],
    attempts: ArtifactClasspathProviderAttempt[],
  ): Promise<void> {
    try {
      const resolved = await provider.resolveArtifacts(context);
      artifacts.push(...resolved);
      attempts.push(createProviderAttempt(provider.id, resolved.length));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      attempts.push({ providerId: provider.id, status: 'failed', artifactCount: 0, error: message });
      console.warn(
        `[stage:jvm-artifact-enrichment] ${provider.id} classpath resolution failed for `
        + `${context.root.id}: ${message}`,
      );
    }
  }
}

function createProviderAttempt(
  providerId: ArtifactClasspathProviderId,
  artifactCount: number,
): ArtifactClasspathProviderAttempt {
  return {
    providerId,
    status: artifactCount > 0 ? 'resolved' : 'empty',
    artifactCount,
  };
}
