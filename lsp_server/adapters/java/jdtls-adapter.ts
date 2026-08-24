/**
 * Eclipse JDT.LS adapter: same vscode-jsonrpc transport as other languages,
 * with compiler-sized initialize wait and ServiceReady tracking.
 */

import { BaseStdioLspAdapter, StdioProcessLaunch } from '../base-stdio-adapter.js';
import {
  createJdtlsProcessLaunch,
  JavaBuildSystemKind,
  JdtlsRuntimeLocator,
  JdtlsWorkspace,
} from './jdtls-runtime.js';
import { ensureBazelProjectModel } from './bazel-project-model.js';

export interface JavaJdtlsAdapterOptions {
  buildRootId?: string;
  buildSystems?: JavaBuildSystemKind[];
  excludedRoots?: string[];
  bazelModelPrepared?: boolean;
}

/** Tracks `language/status` until ServiceReady and Maven/Gradle import go quiet. */
class JdtlsStatusTracker {
  private serviceReady = false;
  private serviceReadyResolve: (() => void) | null = null;
  private lastStatusAt = 0;

  noteLanguageStatus(params: unknown): void {
    this.lastStatusAt = Date.now();
    const type = (params as { type?: string } | null)?.type;
    if (type === 'ServiceReady' || type === 'Started') {
      this.serviceReady = true;
      this.serviceReadyResolve?.();
    }
  }

  async waitUntilServiceReady(timeoutMs: number): Promise<void> {
    if (this.serviceReady) return;
    await Promise.race([
      new Promise<void>((resolve) => {
        this.serviceReadyResolve = resolve;
        if (this.serviceReady) resolve();
      }),
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
  }

  async waitUntilStatusQuiet(quietMs: number, capMs: number): Promise<void> {
    const settleStart = Date.now();
    while (Date.now() - settleStart < capMs) {
      const idleFor = Date.now() - (this.lastStatusAt || settleStart);
      if (idleFor >= quietMs) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
}

export class JavaJdtlsAdapter extends BaseStdioLspAdapter {
  public readonly id = 'jdtls';
  public readonly language = 'java';
  public readonly maxConcurrentRequests = 1;

  private workspace: JdtlsWorkspace | null = null;
  private readonly status = new JdtlsStatusTracker();

  constructor(private readonly options: JavaJdtlsAdapterOptions = {}) {
    super();
  }

  public override getSessionMetadata(): { workspacePath?: string; buildRootId?: string; buildSystems?: string[] } {
    return { ...super.getSessionMetadata(), buildRootId: this.options.buildRootId, buildSystems: this.options.buildSystems };
  }

  public async isAvailable(): Promise<boolean> {
    return JdtlsRuntimeLocator.isInstalled();
  }

  protected onServerNotification(method: string, params: unknown): void {
    if (method === 'language/status') this.status.noteLanguageStatus(params);
  }

  protected queryTimeoutMs(): number {
    return this.workspace?.importBuildTools() ? 20_000 : 12_000;
  }

  protected initializeTimeoutMs(_workspacePath: string): number | undefined {
    return this.workspace?.initializeTimeoutMs() ?? 60_000;
  }

  protected async waitUntilWorkspaceReady(_workspacePath: string): Promise<void> {
    const workspace = this.workspace;
    if (!workspace) return;
    await this.status.waitUntilServiceReady(workspace.serviceReadyTimeoutMs());
    // Indexing still runs after ServiceReady. Querying during that window
    // just hits per-RPC timeouts. Wait until status is quiet, then enrich.
    await this.status.waitUntilStatusQuiet(
      workspace.importBuildTools() ? 4000 : 2000,
      workspace.importQuietTimeoutMs()
    );
  }

  protected async buildProcessLaunch(workspacePath: string): Promise<StdioProcessLaunch> {
    this.workspace = JdtlsWorkspace.inspect(workspacePath, {
      buildSystems: this.options.buildSystems,
      excludedRoots: this.options.excludedRoots,
    });
    if (this.workspace.usesBazel && this.workspace.buildImportEnabled('bazel') && !this.options.bazelModelPrepared) {
      const result = await ensureBazelProjectModel(workspacePath);
      if (result.status === 'failed') console.warn(`[jdtls] ${result.reason}`);
      if (result.status === 'generated') {
        this.workspace = JdtlsWorkspace.inspect(workspacePath, {
          buildSystems: this.options.buildSystems,
          excludedRoots: this.options.excludedRoots,
        });
      }
    }
    const runtime = JdtlsRuntimeLocator.locate(this.workspace.requiredJavaMajor);
    return createJdtlsProcessLaunch(workspacePath, this.workspace, runtime);
  }
}
