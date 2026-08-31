import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ArtifactClasspathResolver } from '../artifact/classpath/index.js';
import { appendObservationBatch, mergeObservationBatches, type LspObservationBatch } from '../ingest/batch.js';
import { ingestRun } from '../ingest/builders.js';
import { collectCapabilities, withCompleteCapabilityCoverage } from '../ingest/collector.js';
import { crawlLspBuildRoot, workspaceDocument } from '../ingest/crawler.js';
import type { LspAnalysisRun, LspBuildRoot, LspServer } from '../model.js';
import {
  enabledNativeJdtBuildSystems,
  JdtlsWorkspace,
  type JavaBuildRoot,
} from '../../../lsp_server/public-api.js';
import { LspAdapterRegistry } from '../../../lsp_server/public-api.js';
import type { JavaBuildRootCrawlResult, JavaBuildRootPreparation } from './types.js';
import type { ILspAdapter } from '../../../lsp_server/public-api.js';
import type { CrawlProfile } from '../ingest/crawl-profile.js';

export interface CrawlJavaBuildRootRequest {
  adapterRegistry: LspAdapterRegistry;
  artifactClasspathResolver: ArtifactClasspathResolver;
  repositoryPath: string;
  run: LspAnalysisRun;
  root: JavaBuildRoot;
  files: string[];
  preparation?: JavaBuildRootPreparation;
  artifactManifestPaths?: string[];
  sharedAdapter?: ILspAdapter;
  processShardId?: string;
  requireSharedAdapter?: boolean;
  crawlProfile?: CrawlProfile;
}

export async function crawlJavaBuildRoot(
  request: CrawlJavaBuildRootRequest,
): Promise<JavaBuildRootCrawlResult> {
  const {
    adapterRegistry,
    artifactClasspathResolver,
    repositoryPath,
    run,
    root,
    files,
    preparation,
    artifactManifestPaths = [],
    sharedAdapter,
    processShardId,
    requireSharedAdapter = false,
    crawlProfile = 'exhaustive',
  } = request;
  const buildRoot = createBuildRoot(run, root, preparation);
  const server = createLspServer(run, root, processShardId);
  const configuredOrigins = new Map((preparation?.crawlSources ?? []).flatMap((source) => [
    [path.resolve(source.path), source.origin] as const,
    [path.resolve(source.analysisPath), source.origin] as const,
  ]));
  const documents = files.map((file) => workspaceDocument(
    file,
    root.id,
    documentOrigin(file, root.workspacePath, configuredOrigins.get(path.resolve(file))),
  ));

  if (root.systems.includes('bazel') && preparation?.status === 'failed') {
    console.warn(`[${root.id}] refusing semantic crawl without Bazel classpath: ${preparation.reason}`);
    return failedBuildRootResult(
      artifactClasspathResolver,
      run,
      root,
      server,
      buildRoot,
      documents,
      preparation,
      artifactManifestPaths,
    );
  }

  const adapter = sharedAdapter ?? (requireSharedAdapter ? null : await adapterRegistry.getOrStartJavaBuildRoot(root));
  if (!adapter) {
    return failedBuildRootResult(
      artifactClasspathResolver,
      run,
      root,
      server,
      buildRoot,
      documents,
      preparation,
      artifactManifestPaths,
    );
  }

  applyServerMetadata(server, adapter.getServerCapabilities());
  try {
    const batch = await crawlLspBuildRoot({
      run,
      server,
      buildRoot,
      documents,
      adapter,
      repositoryPath,
      profile: crawlProfile,
    });
    await appendSpringObservations(adapterRegistry, adapter, root, run, batch);
    const artifactResolution = await artifactClasspathResolver.resolveArtifacts({
      root,
      nativeImporter: nativeImporter(root),
      lspClient: adapter,
      documentUris: documents.map((document) => document.uri),
      bazelModelPath: preparation?.modelPath,
      manifestPaths: artifactManifestPaths,
    });
    const providerIds = [...new Set(artifactResolution.artifacts.flatMap((artifact) => artifact.providerIds))];
    console.log(
      `[${root.id}] artifact classpath: ${artifactResolution.artifacts.length} JARs via `
      + `${providerIds.join(', ') || 'none'}`,
    );
    const errorCount = batch.coverage.reduce((sum, coverage) => sum + coverage.failureCount, 0);
    const timeoutCount = batch.coverage.reduce((sum, coverage) => sum + coverage.timeoutCount, 0);
    server.status = errorCount > 0 || timeoutCount > 0 ? 'partial' : 'complete';
    return {
      batch,
      artifacts: artifactResolution.artifacts,
      artifactClasspathAttempts: artifactResolution.attempts,
      failed: false,
      errorCount,
      timeoutCount,
    };
  } catch (error) {
    server.status = 'failed';
    console.warn(`[${root.id}] crawl failed: ${error instanceof Error ? error.message : String(error)}`);
    const artifactResolution = await artifactClasspathResolver.resolveArtifacts({
      root,
      nativeImporter: nativeImporter(root),
      lspClient: adapter,
      documentUris: documents.map((document) => document.uri),
      bazelModelPath: preparation?.modelPath,
      manifestPaths: artifactManifestPaths,
    });
    return {
      batch: ingestRun(run, [server], documents, [buildRoot]),
      artifacts: artifactResolution.artifacts,
      artifactClasspathAttempts: artifactResolution.attempts,
      failed: true,
      errorCount: 1,
      timeoutCount: error instanceof Error && /timeout|timed out/i.test(error.message) ? 1 : 0,
    };
  } finally {
    if (!sharedAdapter) await adapterRegistry.shutdownAdapter(adapter);
  }
}

async function appendSpringObservations(
  registry: LspAdapterRegistry,
  javaAdapter: ILspAdapter,
  root: JavaBuildRoot,
  run: LspAnalysisRun,
  batch: LspObservationBatch,
): Promise<void> {
  const spring = registry.getJavaCompanion(javaAdapter, root.id);
  if (!spring) return;
  const [projects, structure] = await Promise.all([
    spring.request<unknown[]>('workspace/executeCommand', {
      command: 'sts/spring-boot/executableBootProjects', arguments: [],
    }),
    spring.request<unknown[]>('workspace/executeCommand', {
      command: 'sts/spring-boot/structure', arguments: [{ updateMetadata: true }],
    }),
  ]);
  const springServer: LspServer = {
    id: `server:${run.id}:spring-tools:${encodeURIComponent(root.id)}`,
    runId: run.id,
    name: 'spring-boot-language-server',
    languageId: 'java',
    status: 'complete',
    capabilitiesJson: JSON.stringify(spring.getServerCapabilities()),
    observationsJson: JSON.stringify({
      'sts/spring-boot/executableBootProjects': projects,
      'sts/spring-boot/structure': structure,
    }),
    buildRootId: root.id,
  };
  appendObservationBatch(batch, ingestRun(run, [springServer], [], []));
  console.log(`[${root.id}] Spring Tools: ${projects.length} projects, ${countSpringStructure(structure)} structure nodes`);
}

function countSpringStructure(values: unknown[]): number {
  let count = 0;
  const pending = [...values];
  while (pending.length > 0) {
    const value = pending.pop();
    if (!value || typeof value !== 'object') continue;
    count += 1;
    const children = (value as { children?: unknown }).children;
    if (Array.isArray(children)) pending.push(...children);
  }
  return count;
}

function documentOrigin(
  filePath: string,
  workspacePath: string,
  configuredOrigin?: 'repository' | 'generated' | 'source_jar',
): 'workspace' | 'generated' {
  if (configuredOrigin === 'repository') return 'workspace';
  if (configuredOrigin === 'generated' || configuredOrigin === 'source_jar') return 'generated';
  return isGeneratedCrawlFile(filePath, workspacePath) ? 'generated' : 'workspace';
}

function isGeneratedCrawlFile(filePath: string, workspacePath: string): boolean {
  const relative = path.relative(workspacePath, path.resolve(filePath));
  const parts = relative.split(path.sep);
  return path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)
    || parts.includes('.gitnexus') || parts.some((part) => part === 'bazel-out' || part.startsWith('bazel-out-'));
}

function createBuildRoot(
  run: LspAnalysisRun,
  root: JavaBuildRoot,
  preparation?: JavaBuildRootPreparation,
): LspBuildRoot {
  return {
    id: root.id,
    runId: run.id,
    workspaceUri: pathToFileURL(root.workspacePath).href,
    repositoryPath: root.workspacePath,
    relativePath: root.relativePath,
    buildSystems: root.systems,
    javaMajor: JdtlsWorkspace.inspect(root.workspacePath, {
      buildSystems: root.systems,
      excludedRoots: root.excludedRoots,
    }).requiredJavaMajor,
    importStatus: preparation?.status === 'failed'
      ? 'failed'
      : preparation?.status === 'disabled'
        ? 'disabled'
        : 'ready',
    configurationHash: preparation?.configurationHash,
    excludedRootIds: root.excludedRoots,
  };
}

function createLspServer(run: LspAnalysisRun, root: JavaBuildRoot, processShardId?: string): LspServer {
  return {
    id: `server:${run.id}:${root.id}`,
    runId: run.id,
    name: 'jdtls',
    languageId: 'java',
    status: 'partial',
    capabilitiesJson: '{}',
    buildRootId: root.id,
    processShardId,
  };
}

function applyServerMetadata(server: LspServer, capabilities: Record<string, unknown>): void {
  const serverInfo = capabilities.__serverInfo as { name?: string; version?: string } | undefined;
  server.name = serverInfo?.name ?? server.name;
  server.version = serverInfo?.version;
  server.capabilitiesJson = JSON.stringify(capabilities);
}

async function failedBuildRootResult(
  artifactClasspathResolver: ArtifactClasspathResolver,
  run: LspAnalysisRun,
  root: JavaBuildRoot,
  server: LspServer,
  buildRoot: LspBuildRoot,
  documents: LspObservationBatch['documents'],
  preparation?: JavaBuildRootPreparation,
  artifactManifestPaths: string[] = [],
): Promise<JavaBuildRootCrawlResult> {
  server.status = 'failed';
  const baseBatch = ingestRun(run, [server], documents, [buildRoot]);
  const coverageBatch = await collectCapabilities(
    { runId: run.id, serverId: server.id },
    withCompleteCapabilityCoverage([], 'java'),
  );
  const artifactResolution = await artifactClasspathResolver.resolveArtifacts({
    root,
    nativeImporter: nativeImporter(root),
    documentUris: documents.map((document) => document.uri),
    bazelModelPath: preparation?.modelPath,
    manifestPaths: artifactManifestPaths,
  });
  return {
    batch: mergeObservationBatches(baseBatch, coverageBatch),
    artifacts: artifactResolution.artifacts,
    artifactClasspathAttempts: artifactResolution.attempts,
    failed: true,
    errorCount: 1,
    timeoutCount: 0,
  };
}

function nativeImporter(root: JavaBuildRoot): 'maven' | 'gradle' | undefined {
  const [selected] = enabledNativeJdtBuildSystems(root);
  return selected === 'maven' || selected === 'gradle' ? selected : undefined;
}
