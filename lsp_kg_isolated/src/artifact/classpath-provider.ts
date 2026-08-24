import fs from 'node:fs';
import path from 'node:path';

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
}

export interface ArtifactClasspathBuildRoot {
  id: string;
  workspacePath: string;
  systems: string[];
}

export interface ArtifactClasspathLspAdapter {
  request<T>(method: string, params: unknown): Promise<T>;
}

export interface ArtifactClasspathProviderContext {
  root: ArtifactClasspathBuildRoot;
  adapter?: ArtifactClasspathLspAdapter;
  documentUris: string[];
  bazelModelPath?: string;
  manifestPaths?: string[];
}

export interface ArtifactClasspathProvider {
  readonly id: ArtifactClasspathProviderId;
  supports(context: ArtifactClasspathProviderContext): boolean;
  resolve(context: ArtifactClasspathProviderContext): Promise<NormalizedArtifactDescriptor[]>;
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

interface JdtClasspathResult {
  projectRoot?: string;
  classpaths?: unknown;
  modulepaths?: unknown;
}

interface SharedContext extends ArtifactClasspathProviderContext {
  jdtClasspaths(): Promise<Array<{ path: string; modulePath: boolean }>>;
}

export class ArtifactClasspathProviderRegistry {
  constructor(private readonly providers: ArtifactClasspathProvider[] = defaultArtifactClasspathProviders()) {}

  async resolve(context: ArtifactClasspathProviderContext): Promise<ArtifactClasspathResolution> {
    let jdtPromise: Promise<Array<{ path: string; modulePath: boolean }>> | undefined;
    const shared: SharedContext = {
      ...context,
      jdtClasspaths: () => jdtPromise ??= queryJdtClasspaths(context),
    };
    const resolved: NormalizedArtifactDescriptor[] = [];
    const attempts: ArtifactClasspathProviderAttempt[] = [];
    for (const provider of this.providers) {
      if (!provider.supports(context)) continue;
      try {
        const values = await provider.resolve(shared);
        resolved.push(...values);
        attempts.push({ providerId: provider.id, status: values.length > 0 ? 'resolved' : 'empty', artifactCount: values.length });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        attempts.push({ providerId: provider.id, status: 'failed', artifactCount: 0, error: message });
        console.warn(`[stage:jvm-artifact-enrichment] ${provider.id} classpath resolution failed for ` +
          `${context.root.id}: ${message}`);
      }
    }
    if (resolved.length === 0 && context.adapter) {
      try {
        const values = await new JdtLsClasspathProvider().resolve(shared);
        resolved.push(...values);
        attempts.push({ providerId: 'jdt-ls', status: values.length > 0 ? 'resolved' : 'empty', artifactCount: values.length });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        attempts.push({ providerId: 'jdt-ls', status: 'failed', artifactCount: 0, error: message });
        console.warn(`[stage:jvm-artifact-enrichment] jdt-ls classpath fallback failed for ` +
          `${context.root.id}: ${message}`);
      }
    }
    return { artifacts: mergeDescriptors(resolved), attempts };
  }
}

export class BazelJavaInfoClasspathProvider implements ArtifactClasspathProvider {
  readonly id = 'bazel-java-info' as const;
  supports(context: ArtifactClasspathProviderContext): boolean {
    return context.root.systems.includes('bazel') && Boolean(context.bazelModelPath);
  }
  async resolve(context: ArtifactClasspathProviderContext): Promise<NormalizedArtifactDescriptor[]> {
    if (!context.bazelModelPath) return [];
    const model = JSON.parse(fs.readFileSync(context.bazelModelPath, 'utf8')) as {
      classpath?: unknown; runtimeClasspath?: unknown;
    };
    if (!Array.isArray(model.classpath)) return [];
    const runtime = Array.isArray(model.runtimeClasspath)
      ? model.runtimeClasspath.filter((value): value is string => typeof value === 'string')
        .map((value) => resolveAgainst(value, path.dirname(context.bazelModelPath!)))
      : [];
    const descriptors = model.classpath.flatMap((value) => typeof value === 'string'
      ? descriptorForJar(context.root.id, this.id, resolveAgainst(value, path.dirname(context.bazelModelPath!)), 'compile')
      : []);
    for (const descriptor of descriptors) {
      if (!descriptor.headerJarPath || descriptor.binaryJarPath) continue;
      descriptor.binaryJarPath = matchingRuntimeJar(descriptor.headerJarPath, runtime);
    }
    return descriptors;
  }
}

export class MavenM2eClasspathProvider implements ArtifactClasspathProvider {
  readonly id = 'maven-m2e' as const;
  supports(context: ArtifactClasspathProviderContext): boolean {
    return context.root.systems.includes('maven') && Boolean(context.adapter);
  }
  async resolve(context: ArtifactClasspathProviderContext): Promise<NormalizedArtifactDescriptor[]> {
    const shared = context as SharedContext;
    return (await shared.jdtClasspaths()).flatMap((entry) => descriptorForJar(
      context.root.id, this.id, entry.path, 'runtime', entry.modulePath,
    ));
  }
}

export class GradleBuildshipClasspathProvider implements ArtifactClasspathProvider {
  readonly id = 'gradle-buildship' as const;
  supports(context: ArtifactClasspathProviderContext): boolean {
    return context.root.systems.includes('gradle') && Boolean(context.adapter);
  }
  async resolve(context: ArtifactClasspathProviderContext): Promise<NormalizedArtifactDescriptor[]> {
    const shared = context as SharedContext;
    return (await shared.jdtClasspaths()).flatMap((entry) => descriptorForJar(
      context.root.id, this.id, entry.path, 'runtime', entry.modulePath,
    ));
  }
}

export class JdtLsClasspathProvider implements ArtifactClasspathProvider {
  readonly id = 'jdt-ls' as const;
  supports(context: ArtifactClasspathProviderContext): boolean { return Boolean(context.adapter); }
  async resolve(context: ArtifactClasspathProviderContext): Promise<NormalizedArtifactDescriptor[]> {
    const shared = context as SharedContext;
    const entries = shared.jdtClasspaths ? await shared.jdtClasspaths() : await queryJdtClasspaths(context);
    return entries.flatMap((entry) => descriptorForJar(
      context.root.id, this.id, entry.path, 'runtime', entry.modulePath,
    ));
  }
}

export class ExplicitClasspathManifestProvider implements ArtifactClasspathProvider {
  readonly id = 'explicit-manifest' as const;
  supports(context: ArtifactClasspathProviderContext): boolean {
    return manifestPaths(context).some(fs.existsSync);
  }
  async resolve(context: ArtifactClasspathProviderContext): Promise<NormalizedArtifactDescriptor[]> {
    const result: NormalizedArtifactDescriptor[] = [];
    for (const manifestPath of manifestPaths(context).filter(fs.existsSync)) {
      const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
        classpath?: unknown;
        artifacts?: unknown;
      };
      const entries = Array.isArray(parsed.artifacts) ? parsed.artifacts : parsed.classpath;
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) {
        if (typeof entry === 'string') {
          result.push(...descriptorForJar(
            context.root.id, this.id, resolveAgainst(entry, path.dirname(manifestPath)), 'unknown', false,
          ));
          continue;
        }
        if (!entry || typeof entry !== 'object') continue;
        const value = entry as Record<string, unknown>;
        const rawPath = stringValue(value.classpathEntryPath) ?? stringValue(value.binaryJarPath)
          ?? stringValue(value.headerJarPath);
        if (!rawPath) continue;
        const classpathEntryPath = resolveAgainst(rawPath, path.dirname(manifestPath));
        if (!isJar(classpathEntryPath)) continue;
        const headerJarPath = resolveOptional(value.headerJarPath, path.dirname(manifestPath));
        result.push({
          buildRootId: context.root.id,
          providerIds: [this.id],
          scope: scopeValue(value.scope),
          modulePath: value.modulePath === true,
          classpathEntryPath,
          headerJarPath,
          binaryJarPath: resolveOptional(value.binaryJarPath, path.dirname(manifestPath))
            ?? (headerJarPath ? inferBinaryJar(headerJarPath) : classpathEntryPath),
          sourceJarPath: resolveOptional(value.sourceJarPath, path.dirname(manifestPath)),
          coordinate: stringValue(value.coordinate) ?? inferMavenCoordinate(classpathEntryPath),
        });
      }
    }
    return result;
  }
}

export function defaultArtifactClasspathProviders(): ArtifactClasspathProvider[] {
  return [
    new ExplicitClasspathManifestProvider(),
    new BazelJavaInfoClasspathProvider(),
    new MavenM2eClasspathProvider(),
    new GradleBuildshipClasspathProvider(),
  ];
}

export function inferBinaryJar(entry: string): string | undefined {
  const candidates = [
    entry.replace(/([/\\])header_([^/\\]+)$/, '$1processed_$2'),
    entry.replace(/([/\\])header_([^/\\]+)$/, '$1$2'),
    entry.replace(/-hjar\.jar$/, '.jar'),
    entry.replace(/-ijar\.jar$/, '.jar'),
  ];
  return candidates.find((candidate) => candidate !== entry && fs.existsSync(candidate));
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

function descriptorForJar(
  buildRootId: string,
  provider: ArtifactClasspathProviderId,
  classpathEntryPath: string,
  scope: ArtifactClasspathScope,
  modulePath = false,
): NormalizedArtifactDescriptor[] {
  if (!isBinaryJar(classpathEntryPath) || !fs.existsSync(classpathEntryPath)) return [];
  const binaryJarPath = inferBinaryJar(classpathEntryPath);
  const header = /(?:^|[/\\])header_|-(?:hjar|ijar)\.jar$/i.test(classpathEntryPath);
  return [{
    buildRootId,
    providerIds: [provider],
    scope,
    modulePath,
    classpathEntryPath,
    headerJarPath: header || binaryJarPath ? classpathEntryPath : undefined,
    binaryJarPath: binaryJarPath ?? (header ? undefined : classpathEntryPath),
    coordinate: inferMavenCoordinate(classpathEntryPath),
  }];
}

async function queryJdtClasspaths(
  context: ArtifactClasspathProviderContext,
): Promise<Array<{ path: string; modulePath: boolean }>> {
  if (!context.adapter) return [];
  let projectUris: string[] = [];
  try {
    const projects = await context.adapter.request<unknown>('workspace/executeCommand', {
      command: 'java.project.getAll', arguments: [JSON.stringify({ includeNonJava: false })],
    });
    if (Array.isArray(projects)) projectUris = projects.filter((value): value is string => typeof value === 'string');
  } catch { /* representative document fallback below */ }
  const queryUris = projectUris.length > 0 ? projectUris : context.documentUris.slice(0, 1);
  const entries = new Map<string, { path: string; modulePath: boolean }>();
  for (const uri of queryUris) {
    const response = await context.adapter.request<JdtClasspathResult>('workspace/executeCommand', {
      // JDT LS JSONUtility accepts JsonElement/model instances or a JSON string.
      // vscode-jsonrpc delivers custom command arguments as plain objects, so
      // serialize extension-specific option models explicitly.
      command: 'java.project.getClasspaths', arguments: [uri, JSON.stringify({ scope: 'runtime' })],
    });
    addJdtPaths(entries, response.classpaths, false);
    addJdtPaths(entries, response.modulepaths, true);
  }
  return [...entries.values()];
}

function addJdtPaths(
  target: Map<string, { path: string; modulePath: boolean }>,
  values: unknown,
  modulePath: boolean,
): void {
  if (!Array.isArray(values)) return;
  for (const value of values) {
    if (typeof value !== 'string' || !isJar(value) || !fs.existsSync(value)) continue;
    const absolute = path.resolve(value);
    const existing = target.get(absolute);
    target.set(absolute, { path: absolute, modulePath: existing?.modulePath === true || modulePath });
  }
}

function mergeDescriptors(values: NormalizedArtifactDescriptor[]): NormalizedArtifactDescriptor[] {
  const result = new Map<string, NormalizedArtifactDescriptor>();
  for (const value of values) {
    const key = [value.buildRootId, value.headerJarPath ?? '', value.binaryJarPath ?? value.classpathEntryPath].join('\0');
    const existing = result.get(key);
    if (!existing) { result.set(key, value); continue; }
    existing.providerIds = [...new Set([...existing.providerIds, ...value.providerIds])];
    existing.modulePath ||= value.modulePath;
    existing.sourceJarPath ??= value.sourceJarPath;
    existing.coordinate ??= value.coordinate;
    if (existing.scope === 'unknown') existing.scope = value.scope;
  }
  return [...result.values()];
}

function matchingRuntimeJar(header: string, runtime: string[]): string | undefined {
  const coordinate = inferMavenCoordinate(header);
  return runtime.find((value) => coordinate && inferMavenCoordinate(value) === coordinate && artifactFileKey(value) === artifactFileKey(header))
    ?? runtime.find((value) => artifactFileKey(value) === artifactFileKey(header));
}

function artifactFileKey(value: string): string {
  return path.basename(value).replace(/^(?:header_|processed_)/, '')
    .replace(/-(?:hjar|ijar)\.jar$/, '.jar');
}

function manifestPaths(context: ArtifactClasspathProviderContext): string[] {
  const configured = process.env.GITNEXUS_ARTIFACT_CLASSPATH_MANIFEST;
  return [...(context.manifestPaths ?? []), ...(configured ? configured.split(path.delimiter) : []),
    path.join(context.root.workspacePath, '.gitnexus/artifact-classpath.json')];
}
function resolveAgainst(value: string, directory: string): string {
  return path.resolve(directory, value);
}
function resolveOptional(value: unknown, directory: string): string | undefined {
  const parsed = stringValue(value); return parsed ? resolveAgainst(parsed, directory) : undefined;
}
function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
function isJar(value: string): boolean { return value.toLowerCase().endsWith('.jar'); }
function isBinaryJar(value: string): boolean {
  return isJar(value) && !/(?:-sources|-javadoc)\.jar$/i.test(value);
}
function scopeValue(value: unknown): ArtifactClasspathScope {
  return value === 'compile' || value === 'runtime' || value === 'test' ? value : 'unknown';
}
