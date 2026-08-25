import fs from 'node:fs';
import path from 'node:path';
import {
  findMatchingRuntimeJar,
  inferBinaryJarPath,
  inferMavenCoordinate,
  isJarPath,
  normalizeJarClasspathEntry,
  resolvePathFrom,
} from './descriptor-normalizer.js';
import type {
  ArtifactClasspathProvider,
  ArtifactClasspathProviderContext,
  ArtifactClasspathResolutionContext,
  ArtifactClasspathScope,
  NormalizedArtifactDescriptor,
} from './types.js';

export class BazelJavaInfoClasspathProvider implements ArtifactClasspathProvider {
  readonly id = 'bazel-java-info' as const;

  supports(context: ArtifactClasspathResolutionContext): boolean {
    return context.root.systems.includes('bazel') && Boolean(context.bazelModelPath);
  }

  async resolveArtifacts(context: ArtifactClasspathProviderContext): Promise<NormalizedArtifactDescriptor[]> {
    if (!context.bazelModelPath) return [];
    const modelDirectory = path.dirname(context.bazelModelPath);
    const model = JSON.parse(fs.readFileSync(context.bazelModelPath, 'utf8')) as {
      classpath?: unknown;
      runtimeClasspath?: unknown;
    };
    if (!Array.isArray(model.classpath)) return [];
    const runtimeJarPaths = Array.isArray(model.runtimeClasspath)
      ? model.runtimeClasspath
        .filter((value): value is string => typeof value === 'string')
        .map((value) => resolvePathFrom(modelDirectory, value))
      : [];
    const descriptors = model.classpath.flatMap((value) => typeof value === 'string'
      ? normalizeJarClasspathEntry(
        context.root.id,
        this.id,
        resolvePathFrom(modelDirectory, value),
        'compile',
      )
      : []);
    for (const descriptor of descriptors) {
      if (descriptor.headerJarPath && !descriptor.binaryJarPath) {
        descriptor.binaryJarPath = findMatchingRuntimeJar(descriptor.headerJarPath, runtimeJarPaths);
      }
    }
    return descriptors;
  }
}

abstract class JdtImportedClasspathProvider implements ArtifactClasspathProvider {
  abstract readonly id: 'maven-m2e' | 'gradle-buildship' | 'jdt-ls';
  abstract supports(context: ArtifactClasspathResolutionContext): boolean;

  async resolveArtifacts(context: ArtifactClasspathProviderContext): Promise<NormalizedArtifactDescriptor[]> {
    const entries = await context.loadJdtRuntimeClasspath();
    return entries.flatMap((entry) => normalizeJarClasspathEntry(
      context.root.id,
      this.id,
      entry.path,
      'runtime',
      entry.modulePath,
    ));
  }
}

export class MavenM2eClasspathProvider extends JdtImportedClasspathProvider {
  readonly id = 'maven-m2e' as const;

  supports(context: ArtifactClasspathResolutionContext): boolean {
    return context.root.systems.includes('maven') && Boolean(context.lspClient);
  }
}

export class GradleBuildshipClasspathProvider extends JdtImportedClasspathProvider {
  readonly id = 'gradle-buildship' as const;

  supports(context: ArtifactClasspathResolutionContext): boolean {
    return context.root.systems.includes('gradle') && Boolean(context.lspClient);
  }
}

export class JdtLsClasspathProvider extends JdtImportedClasspathProvider {
  readonly id = 'jdt-ls' as const;

  supports(context: ArtifactClasspathResolutionContext): boolean {
    return Boolean(context.lspClient);
  }
}

export class ExplicitClasspathManifestProvider implements ArtifactClasspathProvider {
  readonly id = 'explicit-manifest' as const;

  supports(context: ArtifactClasspathResolutionContext): boolean {
    return collectArtifactManifestPaths(context).some(fs.existsSync);
  }

  async resolveArtifacts(context: ArtifactClasspathProviderContext): Promise<NormalizedArtifactDescriptor[]> {
    const descriptors: NormalizedArtifactDescriptor[] = [];
    const existingManifests = collectArtifactManifestPaths(context).filter(fs.existsSync);
    for (const manifestPath of existingManifests) {
      descriptors.push(...readArtifactManifest(manifestPath, context.root.id, this.id));
    }
    return descriptors;
  }
}

export function createDefaultArtifactClasspathProviders(): ArtifactClasspathProvider[] {
  return [
    new ExplicitClasspathManifestProvider(),
    new BazelJavaInfoClasspathProvider(),
    new MavenM2eClasspathProvider(),
    new GradleBuildshipClasspathProvider(),
  ];
}

function readArtifactManifest(
  manifestPath: string,
  buildRootId: string,
  providerId: 'explicit-manifest',
): NormalizedArtifactDescriptor[] {
  const manifestDirectory = path.dirname(manifestPath);
  const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
    classpath?: unknown;
    artifacts?: unknown;
  };
  const entries = Array.isArray(parsed.artifacts) ? parsed.artifacts : parsed.classpath;
  if (!Array.isArray(entries)) return [];
  return entries.flatMap((entry) => {
    if (typeof entry === 'string') {
      return normalizeJarClasspathEntry(
        buildRootId,
        providerId,
        resolvePathFrom(manifestDirectory, entry),
        'unknown',
      );
    }
    return normalizeManifestEntry(entry, manifestDirectory, buildRootId, providerId);
  });
}

function normalizeManifestEntry(
  entry: unknown,
  manifestDirectory: string,
  buildRootId: string,
  providerId: 'explicit-manifest',
): NormalizedArtifactDescriptor[] {
  if (!entry || typeof entry !== 'object') return [];
  const value = entry as Record<string, unknown>;
  const rawClasspathPath = readNonEmptyString(value.classpathEntryPath)
    ?? readNonEmptyString(value.binaryJarPath)
    ?? readNonEmptyString(value.headerJarPath);
  if (!rawClasspathPath) return [];
  const classpathEntryPath = resolvePathFrom(manifestDirectory, rawClasspathPath);
  if (!isJarPath(classpathEntryPath)) return [];
  const headerJarPath = resolveOptionalPath(value.headerJarPath, manifestDirectory);
  return [{
    buildRootId,
    providerIds: [providerId],
    scope: parseClasspathScope(value.scope),
    modulePath: value.modulePath === true,
    classpathEntryPath,
    headerJarPath,
    binaryJarPath: resolveOptionalPath(value.binaryJarPath, manifestDirectory)
      ?? (headerJarPath ? inferBinaryJarPath(headerJarPath) : classpathEntryPath),
    sourceJarPath: resolveOptionalPath(value.sourceJarPath, manifestDirectory),
    coordinate: readNonEmptyString(value.coordinate) ?? inferMavenCoordinate(classpathEntryPath),
  }];
}

function collectArtifactManifestPaths(context: ArtifactClasspathResolutionContext): string[] {
  const environmentPaths = process.env.GITNEXUS_ARTIFACT_CLASSPATH_MANIFEST;
  return [
    ...(context.manifestPaths ?? []),
    ...(environmentPaths ? environmentPaths.split(path.delimiter) : []),
    path.join(context.root.workspacePath, '.gitnexus/artifact-classpath.json'),
  ];
}

function resolveOptionalPath(value: unknown, baseDirectory: string): string | undefined {
  const parsed = readNonEmptyString(value);
  return parsed ? resolvePathFrom(baseDirectory, parsed) : undefined;
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function parseClasspathScope(value: unknown): ArtifactClasspathScope {
  return value === 'compile' || value === 'runtime' || value === 'test' ? value : 'unknown';
}
