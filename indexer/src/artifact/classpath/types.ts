export type ArtifactClasspathProviderId =
  | 'bazel-java-info'
  | 'maven-m2e'
  | 'gradle-buildship'
  | 'jdt-ls'
  | 'explicit-manifest';

export type ArtifactClasspathScope = 'compile' | 'runtime' | 'test' | 'unknown';

export interface NormalizedArtifactDescriptor {
  buildRootId: string;
  providerIds: ArtifactClasspathProviderId[];
  scope: ArtifactClasspathScope;
  modulePath: boolean;
  classpathEntryPath: string;
  headerJarPath?: string;
  binaryJarPath?: string;
  sourceJarPath?: string;
  coordinate?: string;
  /** Original JAR basenames retained for resolving provider-specific external URIs. */
  classpathEntryAliases?: string[];
}

export interface ArtifactClasspathBuildRoot {
  id: string;
  workspacePath: string;
  systems: string[];
}

export interface ArtifactClasspathLspClient {
  request<T>(method: string, params: unknown): Promise<T>;
}

export interface ArtifactClasspathResolutionContext {
  root: ArtifactClasspathBuildRoot;
  lspClient?: ArtifactClasspathLspClient;
  documentUris: string[];
  bazelModelPath?: string;
  manifestPaths?: string[];
}

export interface ArtifactClasspathProviderContext extends ArtifactClasspathResolutionContext {
  loadJdtRuntimeClasspath(): Promise<ResolvedClasspathEntry[]>;
}

export interface ResolvedClasspathEntry {
  path: string;
  modulePath: boolean;
}

export interface ArtifactClasspathProvider {
  readonly id: ArtifactClasspathProviderId;
  supports(context: ArtifactClasspathResolutionContext): boolean;
  resolveArtifacts(context: ArtifactClasspathProviderContext): Promise<NormalizedArtifactDescriptor[]>;
}

export interface ArtifactClasspathProviderAttempt {
  providerId: ArtifactClasspathProviderId;
  status: 'resolved' | 'empty' | 'failed';
  artifactCount: number;
  error?: string;
}

export interface ArtifactClasspathResolution {
  artifacts: NormalizedArtifactDescriptor[];
  attempts: ArtifactClasspathProviderAttempt[];
}
