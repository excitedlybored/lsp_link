import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import type {
  ArtifactClasspathProviderId,
  ArtifactClasspathScope,
  NormalizedArtifactDescriptor,
} from './types.js';

export function normalizeJarClasspathEntry(
  buildRootId: string,
  providerId: ArtifactClasspathProviderId,
  classpathEntryPath: string,
  scope: ArtifactClasspathScope,
  modulePath = false,
): NormalizedArtifactDescriptor[] {
  if (!isBinaryJar(classpathEntryPath) || !fs.existsSync(classpathEntryPath)) return [];
  const inferredBinaryPath = inferBinaryJarPath(classpathEntryPath);
  const isHeaderJar = /(?:^|[/\\])header_|-(?:hjar|ijar)\.jar$/i.test(classpathEntryPath);
  return [{
    buildRootId,
    providerIds: [providerId],
    scope,
    modulePath,
    classpathEntryPath,
    headerJarPath: isHeaderJar || inferredBinaryPath ? classpathEntryPath : undefined,
    binaryJarPath: inferredBinaryPath ?? (isHeaderJar ? undefined : classpathEntryPath),
    coordinate: inferMavenCoordinate(classpathEntryPath),
  }];
}

export function mergeArtifactDescriptors(
  descriptors: NormalizedArtifactDescriptor[],
): NormalizedArtifactDescriptor[] {
  const mergedByArtifact = new Map<string, NormalizedArtifactDescriptor>();
  for (const descriptor of descriptors) {
    const key = [
      descriptor.buildRootId,
      descriptor.headerJarPath ?? '',
      descriptor.binaryJarPath ?? descriptor.classpathEntryPath,
    ].join('\0');
    const existing = mergedByArtifact.get(key);
    if (!existing) {
      mergedByArtifact.set(key, { ...descriptor, providerIds: [...descriptor.providerIds] });
      continue;
    }
    existing.providerIds = [...new Set([...existing.providerIds, ...descriptor.providerIds])];
    existing.modulePath ||= descriptor.modulePath;
    existing.sourceJarPath ??= descriptor.sourceJarPath;
    existing.coordinate ??= descriptor.coordinate;
    if (existing.scope === 'unknown') existing.scope = descriptor.scope;
  }
  return [...mergedByArtifact.values()];
}

export function findMatchingRuntimeJar(headerJarPath: string, runtimeJarPaths: string[]): string | undefined {
  const coordinate = inferMavenCoordinate(headerJarPath);
  return runtimeJarPaths.find((candidate) => coordinate
    && inferMavenCoordinate(candidate) === coordinate
    && artifactFileKey(candidate) === artifactFileKey(headerJarPath))
    ?? runtimeJarPaths.find((candidate) => artifactFileKey(candidate) === artifactFileKey(headerJarPath));
}

export function inferBinaryJarPath(classpathEntryPath: string): string | undefined {
  const candidates = [
    classpathEntryPath.replace(/([/\\])header_([^/\\]+)$/, '$1processed_$2'),
    classpathEntryPath.replace(/([/\\])header_([^/\\]+)$/, '$1$2'),
    classpathEntryPath.replace(/-hjar\.jar$/, '.jar'),
    classpathEntryPath.replace(/-ijar\.jar$/, '.jar'),
  ];
  return candidates.find((candidate) => candidate !== classpathEntryPath && fs.existsSync(candidate));
}

export function inferMavenCoordinate(value: string): string | undefined {
  const parsed = inferMavenCoordinateParts(value);
  return parsed ? `${parsed.group}:${parsed.artifact}:${parsed.version}` : undefined;
}

export function inferMavenCoordinateParts(
  value: string,
): { group: string; artifact: string; version: string } | undefined {
  const normalized = value.replaceAll('\\', '/');
  const maven = normalized.match(/\/(?:maven2|repository)\/(.+)\/([^/]+)\/([^/]+)\/(?:header_|processed_)?[^/]+\.jar$/);
  if (maven) return { group: maven[1].split('/').join('.'), artifact: maven[2], version: maven[3] };
  const gradle = normalized.match(/\/modules-2\/files-2\.1\/(.+)\/([^/]+)\/([^/]+)\/[^/]+\/[^/]+\.jar$/);
  if (gradle) return { group: gradle[1].split('/').join('.'), artifact: gradle[2], version: gradle[3] };
  return undefined;
}

export function isJarPath(value: string): boolean {
  return value.toLowerCase().endsWith('.jar');
}

export function resolvePathFrom(baseDirectory: string, value: string): string {
  return path.resolve(baseDirectory, value);
}

/**
 * Retains provider JARs outside ephemeral build-tool output directories.
 * Content-addressed hard links deduplicate dependencies shared by many roots.
 */
export function retainArtifactClasspathEntries(
  descriptors: NormalizedArtifactDescriptor[],
  cacheDirectory: string,
): NormalizedArtifactDescriptor[] {
  fs.mkdirSync(cacheDirectory, { recursive: true });
  return descriptors.map((descriptor) => {
    const retainedPaths = new Map<string, string>();
    const retain = (value: string | undefined): string | undefined => {
      if (!value) return undefined;
      const absolutePath = path.resolve(value);
      const existing = retainedPaths.get(absolutePath);
      if (existing) return existing;
      if (!fs.existsSync(absolutePath)) return value;
      const digest = createHash('sha256').update(fs.readFileSync(absolutePath)).digest('hex').slice(0, 20);
      const retainedPath = path.join(cacheDirectory, `${digest}-${path.basename(absolutePath)}`);
      if (!fs.existsSync(retainedPath)) {
        try {
          fs.linkSync(absolutePath, retainedPath);
        } catch {
          fs.copyFileSync(absolutePath, retainedPath);
        }
      }
      retainedPaths.set(absolutePath, retainedPath);
      return retainedPath;
    };
    return {
      ...descriptor,
      classpathEntryPath: retain(descriptor.classpathEntryPath)!,
      headerJarPath: retain(descriptor.headerJarPath),
      binaryJarPath: retain(descriptor.binaryJarPath),
      sourceJarPath: retain(descriptor.sourceJarPath),
    };
  });
}

function isBinaryJar(value: string): boolean {
  return isJarPath(value) && !/(?:-sources|-javadoc)\.jar$/i.test(value);
}

function artifactFileKey(value: string): string {
  return path.basename(value).replace(/^(?:header_|processed_)/, '')
    .replace(/-(?:hjar|ijar)\.jar$/, '.jar');
}
