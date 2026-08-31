import * as fs from 'fs';
import * as path from 'path';
import { globSync } from 'glob';
import type { ILspAdapter } from '../../contracts/lsp-adapter.interface.js';
import type { JavaBuildRoot } from './jdtls-runtime.js';
import type { JdtlsProjectModel } from './jdtls-sharding.js';
import { SpringBootLanguageServerAdapter } from './spring-boot-adapter.js';
import { springToolsEnabled } from './spring-tools-runtime.js';

const SPRING_MARKER = /org\.springframework|spring[-_.]boot|springframework/i;

/** Owns root-scoped Spring Tools companions attached to shared JDT sessions. */
export class SpringCompanionManager {
  private readonly companions = new Map<ILspAdapter, Map<string, ILspAdapter>>();

  public async start(
    javaAdapter: ILspAdapter,
    root: JavaBuildRoot,
    model?: JdtlsProjectModel,
  ): Promise<ILspAdapter | undefined> {
    if (!springToolsEnabled() || !rootLikelyUsesSpring(root, model)) return undefined;
    const spring = new SpringBootLanguageServerAdapter(javaAdapter, root.id);
    if (!(await spring.isAvailable())) return undefined;
    try {
      await spring.start(root.workspacePath);
      await waitForSpringProjectCache(spring, root.id);
      const byRoot = this.companions.get(javaAdapter) ?? new Map<string, ILspAdapter>();
      byRoot.set(root.id, spring);
      this.companions.set(javaAdapter, byRoot);
      return spring;
    } catch (error) {
      console.warn(`[LSP Registry] Spring Tools unavailable for ${root.id}:`, error instanceof Error ? error.message : error);
      try { await spring.shutdown(); } catch { /* partial startup */ }
      return undefined;
    }
  }

  public get(javaAdapter: ILspAdapter, buildRootId?: string): ILspAdapter | undefined {
    const byRoot = this.companions.get(javaAdapter);
    if (!byRoot) return undefined;
    return buildRootId ? byRoot.get(buildRootId) : byRoot.values().next().value;
  }

  public async shutdown(javaAdapter: ILspAdapter): Promise<ILspAdapter[]> {
    const byRoot = this.companions.get(javaAdapter);
    if (!byRoot) return [];
    const stopped = [...byRoot.values()];
    for (const companion of stopped) {
      try { await companion.shutdown(); } catch { /* best-effort companion cleanup */ }
    }
    this.companions.delete(javaAdapter);
    return stopped;
  }

  public clear(): void {
    this.companions.clear();
  }
}

async function waitForSpringProjectCache(
  spring: SpringBootLanguageServerAdapter,
  rootId: string,
): Promise<void> {
  const configured = Number(process.env.GITNEXUS_SPRING_TOOLS_READY_TIMEOUT_MS ?? 30_000);
  if (!Number.isFinite(configured) || configured < 1_000) {
    throw new Error('GITNEXUS_SPRING_TOOLS_READY_TIMEOUT_MS must be at least 1000');
  }
  const deadline = Date.now() + configured;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const projects = await spring.executableBootProjects();
      if (projects.length > 0) return;
      const structure = await spring.springStructure(false);
      if (structure.length > 0) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const suffix = lastError instanceof Error ? `: ${lastError.message}` : '';
  throw new Error(`Spring Tools project cache remained empty for ${rootId}${suffix}`);
}

function rootLikelyUsesSpring(root: JavaBuildRoot, model?: JdtlsProjectModel): boolean {
  if (model && [...model.compileClasspath, ...model.runtimeClasspath].some((entry) => SPRING_MARKER.test(entry))) {
    return true;
  }
  const descriptors = globSync([
    '**/pom.xml', '**/build.gradle', '**/build.gradle.kts', '**/libs.versions.toml',
    '**/BUILD', '**/BUILD.bazel', '**/*.bzl',
  ], {
    cwd: root.workspacePath,
    nodir: true,
    ignore: ['**/.git/**', '**/.gitnexus/**', '**/node_modules/**', '**/target/**', '**/build/**'],
  });
  return descriptors.some((relativePath) => {
    try {
      return SPRING_MARKER.test(fs.readFileSync(path.join(root.workspacePath, relativePath), 'utf8'));
    } catch {
      return false;
    }
  });
}
