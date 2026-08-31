import { BaseStdioLspAdapter, type StdioProcessLaunch } from '../base-stdio-adapter.js';
import type { ILspAdapter } from '../../contracts/lsp-adapter.interface.js';
import { JdtlsRuntimeLocator } from './jdtls-runtime.js';
import { locateSpringToolsRuntime } from './spring-tools-runtime.js';
import type { JdtlsClientCommand } from './jdtls-adapter.js';

interface JdtlsClientCommandSource extends ILspAdapter {
  addClientCommandHandler(handler: (command: JdtlsClientCommand) => unknown): () => void;
}

const JAVA_REQUESTS: Record<string, string> = {
  'sts/javaType': 'sts.java.type',
  'sts/javadocHoverLink': 'sts.java.javadocHoverLink',
  'sts/javaLocation': 'sts.java.location',
  'sts/javadoc': 'sts.java.javadoc',
  'sts/javaSearchTypes': 'sts.java.search.types',
  'sts/javaSearchPackages': 'sts.java.search.packages',
  'sts/javaSubTypes': 'sts.java.hierarchy.subtypes',
  'sts/javaSuperTypes': 'sts.java.hierarchy.supertypes',
  'sts/javaCodeComplete': 'sts.java.code.completions',
  'sts/project/gav': 'sts.project.gav',
};

export class SpringBootLanguageServerAdapter extends BaseStdioLspAdapter {
  readonly id = 'spring-boot-language-server';
  readonly language = 'java';
  readonly maxConcurrentRequests = 1;

  private removeClientCommandHandler?: () => void;

  constructor(private readonly javaAdapter: ILspAdapter, private readonly buildRootId?: string) {
    super();
    const source = javaAdapter as Partial<JdtlsClientCommandSource>;
    if (typeof source.addClientCommandHandler === 'function') {
      this.removeClientCommandHandler = source.addClientCommandHandler((command) =>
        command.command.startsWith('sts4.classpath.')
          ? this.request('workspace/executeCommand', command)
          : null);
    }
  }

  override getSessionMetadata() {
    return { ...super.getSessionMetadata(), buildRootId: this.buildRootId, buildSystems: ['spring-boot'] };
  }

  async isAvailable(): Promise<boolean> { return locateSpringToolsRuntime() !== null && JdtlsRuntimeLocator.locate() !== null; }
  protected initializeTimeoutMs(): number { return 90_000; }
  protected queryTimeoutMs(): number { return 30_000; }

  protected async buildProcessLaunch(): Promise<StdioProcessLaunch> {
    const spring = locateSpringToolsRuntime();
    const java = JdtlsRuntimeLocator.locate();
    if (!spring || !java) throw new Error('Spring Tools or Java runtime is unavailable');
    const logFile = process.env.GITNEXUS_SPRING_TOOLS_LOG_FILE;
    const loggingArgs = logFile
      ? ['-Dspring.profiles.active=file-logging', `-Dlogging.file.name=${logFile}`, '-Dlogging.level.root=debug']
      : [];
    return {
      command: java.jdkJavaBin,
      args: ['-Xmx1G', '-Dsts.lsp.client=gitnexus', '-Xlog:jni+resolve=off', ...loggingArgs, '-jar', spring.languageServerJar],
      initializationOptions: { settings: {
        'boot-java': { java: { reconcilers: true, completions: { 'inject-bean': true }, 'beans-structure-tree': true } },
        'spring-boot': { ls: { logLevel: process.env.GITNEXUS_SPRING_TOOLS_LOG_LEVEL ?? 'error' } },
      } },
    };
  }

  protected override onServerRequest(method: string, params: unknown): unknown {
    if (method === 'sts/addClasspathListener') {
      const callback = (params as { callbackCommandId?: string } | null)?.callbackCommandId;
      return this.executeJavaCommand('sts.java.addClasspathListener', callback ? [callback] : []);
    }
    if (method === 'sts/removeClasspathListener') {
      const callback = (params as { callbackCommandId?: string } | null)?.callbackCommandId;
      return this.executeJavaCommand('sts.java.removeClasspathListener', callback ? [callback] : []);
    }
    const command = JAVA_REQUESTS[method];
    return command ? this.executeJavaCommand(command, [params]) : super.onServerRequest(method, params);
  }

  private executeJavaCommand(command: string, args: unknown[]): Promise<unknown> {
    return this.javaAdapter.request('workspace/executeCommand', { command, arguments: args });
  }

  public springStructure(updateMetadata = false): Promise<unknown[]> {
    return this.request('workspace/executeCommand', {
      command: 'sts/spring-boot/structure', arguments: [{ updateMetadata }],
    });
  }

  public executableBootProjects(): Promise<unknown[]> {
    return this.request('workspace/executeCommand', {
      command: 'sts/spring-boot/executableBootProjects', arguments: [],
    });
  }


  public override async shutdown(): Promise<void> {
    this.removeClientCommandHandler?.();
    this.removeClientCommandHandler = undefined;
    await super.shutdown();
  }
}
