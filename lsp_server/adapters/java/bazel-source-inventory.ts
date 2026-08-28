import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type { BazelScopeResolution } from './bazel-project-model.js';

const execFileAsync = promisify(execFile);
const DEFAULT_SOURCE_JAR_CONCURRENCY = 4;
const MAX_SOURCE_JAR_CONCURRENCY = 16;
const DEFAULT_SOURCE_JAR_TIMEOUT_MS = 2 * 60_000;
const SOURCE_JAR_CACHE_MANIFEST = '.gitnexus-source-cache.json';
const SOURCE_JAR_PROGRESS_INTERVAL_MS = 15_000;

export type BazelCrawlSourceOrigin = 'repository' | 'generated' | 'source_jar';

export interface BazelConfiguredSourceArtifact {
  path: string;
  shortPath?: string;
  isSource: boolean;
}

export interface BazelConfiguredTargetSources {
  label: string;
  ruleKind?: string;
  dependencies?: BazelConfiguredTargetDependency[];
  compileArtifacts?: string[];
  runtimeArtifacts?: string[];
  directSources: BazelConfiguredSourceArtifact[];
  sourceJars: string[];
}

export interface BazelConfiguredTargetDependency {
  label: string;
  attribute: 'deps' | 'exports' | 'runtime_deps' | 'plugins';
}

export interface BazelConfiguredSourceAssociation {
  path: string;
  targetLabels: string[];
}

export interface BazelSourceJarAssociation {
  sourceJarPath: string;
  sourceJarEntry: string;
  targetLabels: string[];
}

export interface BazelCrawlSource {
  path: string;
  analysisPath: string;
  origin: BazelCrawlSourceOrigin;
  contentHash: string;
  targetLabels: string[];
  originalRepositoryPaths: string[];
  configuredSourceAssociations: BazelConfiguredSourceAssociation[];
  sourceJarAssociations: BazelSourceJarAssociation[];
}

export interface BazelSourceInventoryComparison {
  repositorySources: number;
  configuredRepositorySources: number;
  generatedSources: number;
  sourceJarOnlySources: number;
  externalTargetsRetained: number;
  externalSourceJarAssociationsExcluded: number;
  unownedRepositorySources: string[];
  duplicateSources: number;
  crawlSources: number;
}

export interface BazelSourceInventory {
  schemaVersion: 3;
  workspacePath: string;
  configurationHash: string;
  targetQuery: string;
  generatedAt: string;
  targets: BazelConfiguredTargetSources[];
  sources: BazelCrawlSource[];
  comparison: BazelSourceInventoryComparison;
  scopeResolution?: BazelScopeResolution;
}

export interface CreateBazelSourceInventoryInput {
  workspacePath: string;
  configurationHash: string;
  targetQuery: string;
  repositorySources: string[];
  targets: BazelConfiguredTargetSources[];
  extractionRoot: string;
  scopeResolution?: BazelScopeResolution;
  sourceJarConcurrency?: number;
  sourceJarTimeoutMs?: number;
  deadlineAt?: number;
  signal?: AbortSignal;
}

interface CandidateSource extends BazelCrawlSource {
  priority: number;
}

interface ExtractedSourceJarEntry {
  entry: string;
  path: string;
  contentHash: string;
}

interface SourceJarWorkItem {
  contentHash: string;
  associations: Array<{ sourceJarPath: string; targetLabels: string[] }>;
  destination: string;
}

interface SourceJarExtractionResult {
  entries: ExtractedSourceJarEntry[];
  cacheHit: boolean;
}

interface SourceJarCacheManifest {
  schemaVersion: 1;
  sourceJarHash: string;
  entries: Array<{ entry: string; contentHash: string }>;
}

/** Build the repository-union-configured inventory and safely materialize source JAR entries. */
export async function createBazelSourceInventory(
  input: CreateBazelSourceInventoryInput,
): Promise<BazelSourceInventory> {
  const targets = normalizeTargets(input.targets);
  const crawlTargets = targets.filter((target) => isMainRepositoryLabel(target.label));
  const externalTargetsRetained = targets.length - crawlTargets.length;
  const externalSourceJarAssociationsExcluded = targets
    .filter((target) => !isMainRepositoryLabel(target.label))
    .reduce((count, target) => count + target.sourceJars.length, 0);
  console.error(
    `[bazel:source-inventory] crawl scope ${crawlTargets.length} main-repository targets; retained ${externalTargetsRetained} external targets as artifact evidence; excluded ${externalSourceJarAssociationsExcluded} external source-JAR associations`,
  );
  const targetLabelsByPath = new Map<string, Set<string>>();
  for (const target of crawlTargets) {
    for (const source of target.directSources) {
      const resolved = path.resolve(source.path);
      const labels = targetLabelsByPath.get(resolved) ?? new Set<string>();
      labels.add(target.label);
      targetLabelsByPath.set(resolved, labels);
    }
  }

  const jarCandidates = await extractSourceJarCandidates(crawlTargets, input);
  const finalizationStartedAt = Date.now();
  console.error(
    `[bazel:source-inventory] finalizing ${input.repositorySources.length} repository sources, ${targetLabelsByPath.size} configured source paths, and ${jarCandidates.length} extracted source documents`,
  );

  const jarByHash = groupCandidatesByHash(jarCandidates);
  const repositoryCandidates: CandidateSource[] = input.repositorySources
    .map((sourcePath) => {
      const resolved = path.resolve(sourcePath);
      const contentHash = hashFile(resolved);
      const jarMatches = jarByHash.get(contentHash) ?? [];
      const jarMatch = jarMatches[0];
      const labels = new Set(targetLabelsByPath.get(resolved) ?? []);
      for (const candidate of jarMatches) {
        for (const label of candidate.targetLabels) labels.add(label);
      }
      const directLabels = [...(targetLabelsByPath.get(resolved) ?? [])].sort();
      return {
        path: resolved,
        analysisPath: jarMatch?.analysisPath ?? resolved,
        origin: 'repository' as const,
        contentHash,
        targetLabels: [...labels].sort(),
        originalRepositoryPaths: [resolved],
        configuredSourceAssociations: directLabels.length > 0
          ? [{ path: resolved, targetLabels: directLabels }]
          : [],
        sourceJarAssociations: mergeSourceJarAssociations(
          jarMatches.flatMap((candidate) => candidate.sourceJarAssociations),
        ),
        priority: 0,
      };
    });

  const generatedCandidates: CandidateSource[] = [];
  for (const [sourcePath, labels] of targetLabelsByPath) {
    if (!sourcePath.endsWith('.java') || !fs.existsSync(sourcePath)) continue;
    if (isInside(sourcePath, input.workspacePath) && !sourcePath.includes(`${path.sep}bazel-out${path.sep}`)) continue;
    const contentHash = hashFile(sourcePath);
    const jarMatches = jarByHash.get(contentHash) ?? [];
    const jarMatch = jarMatches[0];
    generatedCandidates.push({
      path: sourcePath,
      analysisPath: jarMatch?.analysisPath ?? sourcePath,
      origin: 'generated',
      contentHash,
      targetLabels: [...new Set([
        ...labels,
        ...jarMatches.flatMap((candidate) => candidate.targetLabels),
      ])].sort(),
      originalRepositoryPaths: [],
      configuredSourceAssociations: [{ path: sourcePath, targetLabels: [...labels].sort() }],
      sourceJarAssociations: mergeSourceJarAssociations(
        jarMatches.flatMap((candidate) => candidate.sourceJarAssociations),
      ),
      priority: 1,
    });
  }

  const allCandidates = [...repositoryCandidates, ...generatedCandidates, ...jarCandidates]
    .sort((left, right) => left.priority - right.priority || left.path.localeCompare(right.path));
  const byHash = new Map<string, CandidateSource>();
  let duplicateSources = 0;
  for (const candidate of allCandidates) {
    const existing = byHash.get(candidate.contentHash);
    if (!existing) {
      byHash.set(candidate.contentHash, candidate);
      continue;
    }
    duplicateSources += 1;
    const targetLabels = [...new Set([...existing.targetLabels, ...candidate.targetLabels])].sort();
    const originalRepositoryPaths = uniquePaths([
      ...existing.originalRepositoryPaths,
      ...candidate.originalRepositoryPaths,
    ]);
    const configuredSourceAssociations = mergeConfiguredSourceAssociations([
      ...existing.configuredSourceAssociations,
      ...candidate.configuredSourceAssociations,
    ]);
    const sourceJarAssociations = mergeSourceJarAssociations([
      ...existing.sourceJarAssociations,
      ...candidate.sourceJarAssociations,
    ]);
    if (candidate.priority < existing.priority) {
      Object.assign(existing, candidate);
    }
    existing.targetLabels = targetLabels;
    existing.originalRepositoryPaths = originalRepositoryPaths;
    existing.configuredSourceAssociations = configuredSourceAssociations;
    existing.sourceJarAssociations = sourceJarAssociations;
  }

  const sources = [...byHash.values()]
    .map(({ priority: _priority, ...source }) => source)
    .sort((left, right) => left.path.localeCompare(right.path));
  const unownedRepositorySources = repositoryCandidates
    .filter((candidate) => candidate.targetLabels.length === 0)
    .map((candidate) => path.relative(input.workspacePath, candidate.path).split(path.sep).join('/'))
    .sort();
  console.error(
    `[bazel:source-inventory] finalized ${sources.length} crawl documents in ${formatElapsed(Date.now() - finalizationStartedAt)}; deduplicated ${duplicateSources}`,
  );
  return {
    schemaVersion: 3,
    workspacePath: path.resolve(input.workspacePath),
    configurationHash: input.configurationHash,
    targetQuery: input.targetQuery,
    generatedAt: new Date().toISOString(),
    targets,
    sources,
    comparison: {
      repositorySources: repositoryCandidates.length,
      configuredRepositorySources: repositoryCandidates.length - unownedRepositorySources.length,
      generatedSources: sources.filter((source) => source.origin === 'generated').length,
      sourceJarOnlySources: sources.filter((source) => source.origin === 'source_jar').length,
      externalTargetsRetained,
      externalSourceJarAssociationsExcluded,
      unownedRepositorySources,
      duplicateSources,
      crawlSources: sources.length,
    },
    scopeResolution: input.scopeResolution,
  };
}

export function sourceInventoryHash(inventory: BazelSourceInventory): string {
  const { generatedAt: _generatedAt, ...stableInventory } = inventory;
  return createHash('sha256').update(JSON.stringify(stableInventory)).digest('hex');
}

export function readBazelSourceInventory(inventoryPath: string): BazelSourceInventory | undefined {
  try {
    const value = JSON.parse(fs.readFileSync(inventoryPath, 'utf8')) as Partial<BazelSourceInventory>;
    if (value.schemaVersion !== 3 || !Array.isArray(value.sources) || !Array.isArray(value.targets)) return undefined;
    if (!value.sources.every((source) => typeof source.path === 'string'
      && typeof source.analysisPath === 'string' && typeof source.contentHash === 'string'
      && Array.isArray(source.targetLabels)
      && Array.isArray(source.originalRepositoryPaths)
      && Array.isArray(source.configuredSourceAssociations)
      && Array.isArray(source.sourceJarAssociations))) return undefined;
    return value as BazelSourceInventory;
  } catch {
    return undefined;
  }
}

async function extractSourceJarCandidates(
  targets: BazelConfiguredTargetSources[],
  input: CreateBazelSourceInventoryInput,
): Promise<CandidateSource[]> {
  const labelsByJarPath = new Map<string, Set<string>>();
  let associationCount = 0;
  for (const target of targets) {
    for (const sourceJar of target.sourceJars) {
      associationCount += 1;
      const resolved = path.resolve(sourceJar);
      const labels = labelsByJarPath.get(resolved) ?? new Set<string>();
      labels.add(target.label);
      labelsByJarPath.set(resolved, labels);
    }
  }
  const jarPaths = [...labelsByJarPath.keys()].sort();
  if (jarPaths.length === 0) return [];
  console.error(
    `[bazel:source-inventory] cataloging ${jarPaths.length} unique source-JAR paths from ${associationCount} target associations`,
  );
  const byContentHash = new Map<string, SourceJarWorkItem>();
  const catalogStep = Math.max(1, Math.floor(jarPaths.length / 20));
  for (let index = 0; index < jarPaths.length; index += 1) {
    throwIfAborted(input.signal, 'Source-JAR cataloging was aborted.');
    const sourceJarPath = jarPaths[index];
    const contentHash = hashFile(sourceJarPath);
    const work = byContentHash.get(contentHash) ?? {
      contentHash,
      associations: [],
      destination: path.join(input.extractionRoot, contentHash.slice(0, 24)),
    };
    work.associations.push({
      sourceJarPath,
      targetLabels: [...labelsByJarPath.get(sourceJarPath)!].sort(),
    });
    byContentHash.set(contentHash, work);
    if ((index + 1) % catalogStep === 0 || index + 1 === jarPaths.length) {
      console.error(`[bazel:source-inventory] cataloged ${index + 1}/${jarPaths.length} source-JAR paths`);
    }
  }
  const workItems = [...byContentHash.values()].sort((left, right) =>
    left.contentHash.localeCompare(right.contentHash));
  const concurrency = boundedPositiveInteger(
    input.sourceJarConcurrency ?? environmentPositiveInteger('GITNEXUS_BAZEL_SOURCE_JAR_CONCURRENCY')
      ?? DEFAULT_SOURCE_JAR_CONCURRENCY,
    'source-JAR concurrency',
    MAX_SOURCE_JAR_CONCURRENCY,
  );
  const timeoutMs = boundedPositiveInteger(
    input.sourceJarTimeoutMs ?? environmentPositiveInteger('GITNEXUS_BAZEL_SOURCE_JAR_TIMEOUT_MS')
      ?? DEFAULT_SOURCE_JAR_TIMEOUT_MS,
    'source-JAR timeout',
  );
  console.error(
    `[bazel:source-inventory] extracting ${workItems.length} content-unique source JARs with concurrency ${Math.min(concurrency, workItems.length)}`,
  );
  const results = new Array<SourceJarExtractionResult>(workItems.length);
  const controller = new AbortController();
  const relayAbort = (): void => controller.abort(input.signal?.reason);
  input.signal?.addEventListener('abort', relayAbort, { once: true });
  if (input.signal?.aborted) relayAbort();
  let nextIndex = 0;
  let completed = 0;
  let cacheHits = 0;
  let javaFiles = 0;
  let firstFailure: unknown;
  const startedAt = Date.now();
  const reportProgress = (): void => {
    const percent = workItems.length === 0 ? 100 : Math.floor((completed / workItems.length) * 100);
    console.error(
      `[bazel:source-inventory] completed ${completed}/${workItems.length} source JARs (${percent}%); cache hits ${cacheHits}; Java files ${javaFiles}; elapsed ${formatElapsed(Date.now() - startedAt)}`,
    );
  };
  const heartbeat = setInterval(reportProgress, SOURCE_JAR_PROGRESS_INTERVAL_MS);
  heartbeat.unref();
  const progressStep = Math.max(1, Math.floor(workItems.length / 100));
  const worker = async (): Promise<void> => {
    while (!controller.signal.aborted) {
      const index = nextIndex++;
      if (index >= workItems.length) return;
      const work = workItems[index];
      try {
        const result = await extractJavaSourceJar(work.associations[0].sourceJarPath, work.destination, {
          expectedContentHash: work.contentHash,
          timeoutMs,
          deadlineAt: input.deadlineAt,
          signal: controller.signal,
        });
        results[index] = result;
        completed += 1;
        if (result.cacheHit) cacheHits += 1;
        javaFiles += result.entries.length;
        if (completed % progressStep === 0 || completed === workItems.length) reportProgress();
      } catch (error) {
        if (firstFailure === undefined) firstFailure = error;
        controller.abort(error);
        return;
      }
    }
  };
  try {
    await Promise.all(Array.from(
      { length: Math.min(concurrency, workItems.length) },
      () => worker(),
    ));
  } finally {
    clearInterval(heartbeat);
    input.signal?.removeEventListener('abort', relayAbort);
  }
  if (firstFailure !== undefined) throw firstFailure;
  throwIfAborted(input.signal, 'Source-JAR extraction was aborted.');

  const candidates: CandidateSource[] = [];
  for (let index = 0; index < workItems.length; index += 1) {
    const work = workItems[index];
    const targetLabels = [...new Set(work.associations.flatMap((association) => association.targetLabels))].sort();
    for (const entry of results[index].entries) {
      candidates.push({
        path: entry.path,
        analysisPath: entry.path,
        origin: 'source_jar',
        contentHash: entry.contentHash,
        targetLabels,
        originalRepositoryPaths: [],
        configuredSourceAssociations: [],
        sourceJarAssociations: work.associations.map((association) => ({
          sourceJarPath: association.sourceJarPath,
          sourceJarEntry: entry.entry,
          targetLabels: association.targetLabels,
        })),
        priority: 2,
      });
    }
  }
  return candidates;
}

interface ExtractJavaSourceJarOptions {
  expectedContentHash: string;
  timeoutMs: number;
  deadlineAt?: number;
  signal?: AbortSignal;
}

async function extractJavaSourceJar(
  sourceJar: string,
  destination: string,
  options: ExtractJavaSourceJarOptions,
): Promise<SourceJarExtractionResult> {
  const resolvedJar = path.resolve(sourceJar);
  if (!fs.existsSync(resolvedJar)) throw new Error(`Bazel source JAR does not exist: ${resolvedJar}`);
  throwIfAborted(options.signal, 'Source-JAR extraction was aborted.');
  if (options.deadlineAt !== undefined && options.deadlineAt <= Date.now()) {
    throw new Error('Repository-wide deadline exceeded before source-JAR extraction.');
  }
  const cached = readCachedSourceJarExtraction(destination, options.expectedContentHash);
  if (cached) return { entries: cached, cacheHit: true };
  const remaining = options.deadlineAt === undefined ? options.timeoutMs : options.deadlineAt - Date.now();
  if (remaining <= 0) throw new Error('Repository-wide deadline exceeded before source-JAR extraction.');
  const effectiveTimeoutMs = Math.max(1, Math.min(options.timeoutMs, remaining));
  const controller = new AbortController();
  let timedOut = false;
  const relayAbort = (): void => controller.abort(options.signal?.reason);
  options.signal?.addEventListener('abort', relayAbort, { once: true });
  if (options.signal?.aborted) relayAbort();
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error(`source-JAR extraction exceeded ${effectiveTimeoutMs} ms`));
  }, effectiveTimeoutMs);
  let listing: string;
  try {
    try {
      const jar = findJarExecutable();
      listing = String((await execFileAsync(jar, ['tf', resolvedJar], {
        maxBuffer: 64 * 1024 * 1024,
        signal: controller.signal,
      })).stdout);
    } catch (jarError) {
      if (controller.signal.aborted) throw jarError;
      try {
        listing = String((await execFileAsync('unzip', ['-Z1', resolvedJar], {
          maxBuffer: 64 * 1024 * 1024,
          signal: controller.signal,
        })).stdout);
      } catch (unzipError) {
        if (controller.signal.aborted) throw unzipError;
        const detail = unzipError instanceof Error ? unzipError.message
          : jarError instanceof Error ? jarError.message : String(unzipError);
        throw new Error(`Invalid Bazel source JAR ${resolvedJar}: ${detail}`);
      }
    }
    const entries = listing.split(/\r?\n/).filter(Boolean);
    for (const entry of entries) validateBazelSourceJarEntry(entry, resolvedJar);
    const javaEntries = entries.filter((entry) => entry.endsWith('.java')).sort();
    const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
    fs.rmSync(temporary, { recursive: true, force: true });
    fs.mkdirSync(temporary, { recursive: true });
    try {
      if (javaEntries.length > 0) {
        try {
          // execFile passes the wildcard literally to unzip. This extracts every
          // nested Java entry in one process without materializing other files.
          await execFileAsync('unzip', ['-q', resolvedJar, '*.java', '-d', temporary], {
            maxBuffer: 64 * 1024 * 1024,
            signal: controller.signal,
          });
        } catch (error) {
          if (controller.signal.aborted || !isMissingExecutable(error)) throw error;
          // The JDK jar tool has no archive-entry wildcard support. Keep its
          // fallback command lines bounded on hosts without unzip.
          for (let offset = 0; offset < javaEntries.length; offset += 200) {
            throwIfAborted(controller.signal, 'Source-JAR extraction was aborted.');
            const batch = javaEntries.slice(offset, offset + 200);
            await execFileAsync(findJarExecutable(), ['xf', resolvedJar, ...batch], {
              cwd: temporary,
              maxBuffer: 64 * 1024 * 1024,
              signal: controller.signal,
            });
          }
        }
      }
      const extracted = javaEntries.map((entry) => {
        throwIfAborted(controller.signal, 'Source-JAR extraction was aborted.');
        const extractedPath = path.resolve(temporary, ...entry.split('/'));
        if (!isInside(extractedPath, temporary)) {
          throw new Error(`Bazel source JAR entry was not safely extracted: ${entry}`);
        }
        const extractedStat = fs.lstatSync(extractedPath);
        if (extractedStat.isSymbolicLink() || !extractedStat.isFile()) {
          throw new Error(`Bazel source JAR entry was not safely extracted: ${entry}`);
        }
        return { entry, temporaryPath: extractedPath, contentHash: hashFile(extractedPath) };
      });
      const cacheManifest: SourceJarCacheManifest = {
        schemaVersion: 1,
        sourceJarHash: options.expectedContentHash,
        entries: extracted.map(({ entry, contentHash }) => ({ entry, contentHash })),
      };
      fs.writeFileSync(path.join(temporary, SOURCE_JAR_CACHE_MANIFEST), `${JSON.stringify(cacheManifest)}\n`);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      const previous = `${destination}.${process.pid}.previous`;
      fs.rmSync(previous, { recursive: true, force: true });
      if (fs.existsSync(destination)) fs.renameSync(destination, previous);
      try {
        fs.renameSync(temporary, destination);
        fs.rmSync(previous, { recursive: true, force: true });
      } catch (error) {
        if (fs.existsSync(previous) && !fs.existsSync(destination)) fs.renameSync(previous, destination);
        throw error;
      }
      return {
        entries: extracted.map(({ entry, temporaryPath, contentHash }) => ({
          entry,
          path: path.resolve(destination, path.relative(temporary, temporaryPath)),
          contentHash,
        })),
        cacheHit: false,
      };
    } catch (error) {
      fs.rmSync(temporary, { recursive: true, force: true });
      throw error;
    }
  } catch (error) {
    if (timedOut) throw new Error(`Bazel source-JAR extraction timed out after ${effectiveTimeoutMs} ms.`);
    if (options.signal?.aborted) throw new Error('Bazel source-JAR extraction was aborted.');
    throw error;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', relayAbort);
  }
}

function readCachedSourceJarExtraction(
  destination: string,
  expectedContentHash: string,
): ExtractedSourceJarEntry[] | undefined {
  const manifestPath = path.join(destination, SOURCE_JAR_CACHE_MANIFEST);
  try {
    const value = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Partial<SourceJarCacheManifest>;
    if (value.schemaVersion !== 1 || value.sourceJarHash !== expectedContentHash || !Array.isArray(value.entries)) {
      return undefined;
    }
    const extracted: ExtractedSourceJarEntry[] = [];
    for (const cachedEntry of value.entries) {
      if (!cachedEntry || typeof cachedEntry.entry !== 'string' || typeof cachedEntry.contentHash !== 'string') {
        return undefined;
      }
      validateBazelSourceJarEntry(cachedEntry.entry, manifestPath);
      const extractedPath = path.resolve(destination, ...cachedEntry.entry.split('/'));
      if (!isInside(extractedPath, destination)) return undefined;
      const stat = fs.lstatSync(extractedPath);
      if (stat.isSymbolicLink() || !stat.isFile()) return undefined;
      const contentHash = hashFile(extractedPath);
      if (contentHash !== cachedEntry.contentHash) return undefined;
      extracted.push({ entry: cachedEntry.entry, path: extractedPath, contentHash });
    }
    return extracted;
  } catch {
    return undefined;
  }
}

function boundedPositiveInteger(value: number, name: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${name} must be an integer from 1 to ${maximum}.`);
  }
  return value;
}

function environmentPositiveInteger(name: string): number | undefined {
  const value = process.env[name];
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer.`);
  return parsed;
}

function isMainRepositoryLabel(label: string): boolean {
  return label.startsWith('//') || label.startsWith('@//') || label.startsWith('@@//');
}

function isMissingExecutable(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function throwIfAborted(signal: AbortSignal | undefined, message: string): void {
  if (signal?.aborted) throw new Error(message);
}

function formatElapsed(durationMs: number): string {
  const totalSeconds = Math.floor(durationMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

export function validateBazelSourceJarEntry(entry: string, sourceJar: string): void {
  if (entry.includes('\0') || entry.includes('\\') || path.posix.isAbsolute(entry)) {
    throw new Error(`Unsafe entry in Bazel source JAR ${sourceJar}: ${entry}`);
  }
  const withoutTrailingSlash = entry.endsWith('/') ? entry.slice(0, -1) : entry;
  const components = withoutTrailingSlash.split('/');
  if (
    withoutTrailingSlash.length === 0
    || components.some((component) => component === '' || component === '.' || component === '..')
    || path.posix.normalize(withoutTrailingSlash) !== withoutTrailingSlash
  ) {
    throw new Error(`Unsafe entry in Bazel source JAR ${sourceJar}: ${entry}`);
  }
}

function normalizeTargets(targets: BazelConfiguredTargetSources[]): BazelConfiguredTargetSources[] {
  return targets.map((target) => ({
    label: target.label,
    ruleKind: target.ruleKind,
    dependencies: [...(target.dependencies ?? [])]
      .filter((dependency, index, all) => all.findIndex((candidate) =>
        candidate.label === dependency.label && candidate.attribute === dependency.attribute) === index)
      .sort((left, right) => left.attribute.localeCompare(right.attribute)
        || left.label.localeCompare(right.label)),
    compileArtifacts: uniquePaths(target.compileArtifacts ?? []),
    runtimeArtifacts: uniquePaths(target.runtimeArtifacts ?? []),
    directSources: [...target.directSources]
      .map((source) => ({ ...source, path: path.resolve(source.path) }))
      .sort((left, right) => left.path.localeCompare(right.path)),
    sourceJars: [...new Set(target.sourceJars.map((sourceJar) => path.resolve(sourceJar)))].sort(),
  })).sort((left, right) => left.label.localeCompare(right.label));
}

function groupCandidatesByHash(candidates: CandidateSource[]): Map<string, CandidateSource[]> {
  const grouped = new Map<string, CandidateSource[]>();
  for (const candidate of candidates) {
    const values = grouped.get(candidate.contentHash) ?? [];
    values.push(candidate);
    grouped.set(candidate.contentHash, values);
  }
  return grouped;
}

function mergeConfiguredSourceAssociations(
  associations: BazelConfiguredSourceAssociation[],
): BazelConfiguredSourceAssociation[] {
  const byPath = new Map<string, Set<string>>();
  for (const association of associations) {
    const resolved = path.resolve(association.path);
    const labels = byPath.get(resolved) ?? new Set<string>();
    for (const label of association.targetLabels) labels.add(label);
    byPath.set(resolved, labels);
  }
  return [...byPath].map(([sourcePath, labels]) => ({
    path: sourcePath,
    targetLabels: [...labels].sort(),
  })).sort((left, right) => left.path.localeCompare(right.path));
}

function mergeSourceJarAssociations(
  associations: BazelSourceJarAssociation[],
): BazelSourceJarAssociation[] {
  const byEntry = new Map<string, { sourceJarPath: string; sourceJarEntry: string; labels: Set<string> }>();
  for (const association of associations) {
    const sourceJarPath = path.resolve(association.sourceJarPath);
    const key = `${sourceJarPath}\0${association.sourceJarEntry}`;
    const current = byEntry.get(key) ?? {
      sourceJarPath,
      sourceJarEntry: association.sourceJarEntry,
      labels: new Set<string>(),
    };
    for (const label of association.targetLabels) current.labels.add(label);
    byEntry.set(key, current);
  }
  return [...byEntry.values()].map(({ labels, ...association }) => ({
    ...association,
    targetLabels: [...labels].sort(),
  })).sort((left, right) => left.sourceJarPath.localeCompare(right.sourceJarPath)
    || left.sourceJarEntry.localeCompare(right.sourceJarEntry));
}

function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths.map((sourcePath) => path.resolve(sourcePath)))].sort();
}

function hashFile(filePath: string): string {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function findJarExecutable(): string {
  for (const home of [process.env.GITNEXUS_JDT_JAVA_HOME, process.env.JAVA_HOME]) {
    if (!home) continue;
    const candidate = path.join(home, 'bin', process.platform === 'win32' ? 'jar.exe' : 'jar');
    if (fs.existsSync(candidate)) return candidate;
  }
  return process.platform === 'win32' ? 'jar.exe' : 'jar';
}

function isInside(candidate: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}
