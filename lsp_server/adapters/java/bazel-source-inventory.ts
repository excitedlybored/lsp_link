import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type BazelCrawlSourceOrigin = 'repository' | 'generated' | 'source_jar';

export interface BazelConfiguredSourceArtifact {
  path: string;
  shortPath?: string;
  isSource: boolean;
}

export interface BazelConfiguredTargetSources {
  label: string;
  directSources: BazelConfiguredSourceArtifact[];
  sourceJars: string[];
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
  unownedRepositorySources: string[];
  duplicateSources: number;
  crawlSources: number;
}

export interface BazelSourceInventory {
  schemaVersion: 1;
  workspacePath: string;
  configurationHash: string;
  targetQuery: string;
  generatedAt: string;
  targets: BazelConfiguredTargetSources[];
  sources: BazelCrawlSource[];
  comparison: BazelSourceInventoryComparison;
}

export interface CreateBazelSourceInventoryInput {
  workspacePath: string;
  configurationHash: string;
  targetQuery: string;
  repositorySources: string[];
  targets: BazelConfiguredTargetSources[];
  extractionRoot: string;
}

interface CandidateSource extends BazelCrawlSource {
  priority: number;
}

/** Build the repository-union-configured inventory and safely materialize source JAR entries. */
export async function createBazelSourceInventory(
  input: CreateBazelSourceInventoryInput,
): Promise<BazelSourceInventory> {
  const targets = normalizeTargets(input.targets);
  const targetLabelsByPath = new Map<string, Set<string>>();
  for (const target of targets) {
    for (const source of target.directSources) {
      const resolved = path.resolve(source.path);
      const labels = targetLabelsByPath.get(resolved) ?? new Set<string>();
      labels.add(target.label);
      targetLabelsByPath.set(resolved, labels);
    }
  }

  const jarCandidates: CandidateSource[] = [];
  for (const target of targets) {
    for (const sourceJar of target.sourceJars) {
      const extracted = await extractJavaSourceJar(
        sourceJar,
        path.join(input.extractionRoot, hashFile(sourceJar).slice(0, 24)),
      );
      for (const entry of extracted) {
        jarCandidates.push({
          path: entry.path,
          analysisPath: entry.path,
          origin: 'source_jar',
          contentHash: entry.contentHash,
          targetLabels: [target.label],
          originalRepositoryPaths: [],
          configuredSourceAssociations: [],
          sourceJarAssociations: [{
            sourceJarPath: path.resolve(sourceJar),
            sourceJarEntry: entry.entry,
            targetLabels: [target.label],
          }],
          priority: 2,
        });
      }
    }
  }

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
  return {
    schemaVersion: 1,
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
      unownedRepositorySources,
      duplicateSources,
      crawlSources: sources.length,
    },
  };
}

export function sourceInventoryHash(inventory: BazelSourceInventory): string {
  const { generatedAt: _generatedAt, ...stableInventory } = inventory;
  return createHash('sha256').update(JSON.stringify(stableInventory)).digest('hex');
}

export function readBazelSourceInventory(inventoryPath: string): BazelSourceInventory | undefined {
  try {
    const value = JSON.parse(fs.readFileSync(inventoryPath, 'utf8')) as Partial<BazelSourceInventory>;
    if (value.schemaVersion !== 1 || !Array.isArray(value.sources) || !Array.isArray(value.targets)) return undefined;
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

async function extractJavaSourceJar(
  sourceJar: string,
  destination: string,
): Promise<Array<{ entry: string; path: string; contentHash: string }>> {
  const resolvedJar = path.resolve(sourceJar);
  if (!fs.existsSync(resolvedJar)) throw new Error(`Bazel source JAR does not exist: ${resolvedJar}`);
  let listing: string;
  let extractor: 'jar' | 'unzip';
  try {
    const jar = findJarExecutable();
    listing = String((await execFileAsync(jar, ['tf', resolvedJar], { maxBuffer: 64 * 1024 * 1024 })).stdout);
    extractor = 'jar';
  } catch (jarError) {
    try {
      listing = String((await execFileAsync('unzip', ['-Z1', resolvedJar], { maxBuffer: 64 * 1024 * 1024 })).stdout);
      extractor = 'unzip';
    } catch (unzipError) {
      const detail = unzipError instanceof Error ? unzipError.message
        : jarError instanceof Error ? jarError.message : String(unzipError);
      throw new Error(`Invalid Bazel source JAR ${resolvedJar}: ${detail}`);
    }
  }
  const entries = listing.split(/\r?\n/).filter(Boolean);
  for (const entry of entries) validateBazelSourceJarEntry(entry, resolvedJar);
  const javaEntries = entries.filter((entry) => entry.endsWith('.java')).sort();
  if (javaEntries.length === 0) return [];
  const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
  fs.rmSync(temporary, { recursive: true, force: true });
  fs.mkdirSync(temporary, { recursive: true });
  try {
    // Keep command lines bounded for large source JARs, and never materialize
    // resources or class files that are outside the crawl inventory.
    for (let offset = 0; offset < javaEntries.length; offset += 200) {
      const batch = javaEntries.slice(offset, offset + 200);
      if (extractor === 'jar') {
        await execFileAsync(findJarExecutable(), ['xf', resolvedJar, ...batch], {
          cwd: temporary,
          maxBuffer: 64 * 1024 * 1024,
        });
      } else {
        await execFileAsync('unzip', ['-q', resolvedJar, ...batch, '-d', temporary], {
          maxBuffer: 64 * 1024 * 1024,
        });
      }
    }
    const extracted = javaEntries.map((entry) => {
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
    return extracted.map(({ entry, temporaryPath, contentHash }) => ({
      entry,
      path: path.resolve(destination, path.relative(temporary, temporaryPath)),
      contentHash,
    }));
  } catch (error) {
    fs.rmSync(temporary, { recursive: true, force: true });
    throw error;
  }
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
