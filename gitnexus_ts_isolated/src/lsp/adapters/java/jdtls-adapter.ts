/**
 * Eclipse JDT.LS Adapter implementing ILspAdapter.
 */

import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { ILspAdapter } from '../../contracts/lsp-adapter.interface.js';
import {
  CallHierarchyItem,
  CallHierarchyOutgoingCall,
  CallHierarchyIncomingCall,
  LspHoverResult,
  LspImplementationResult,
} from '../../contracts/lsp-types.js';
import { resolveJdtlsConfig } from './jdtls-launcher.js';
import { JsonRpcChannel } from './jsonrpc-channel.js';

export class JavaJdtlsAdapter implements ILspAdapter {
  public readonly id = 'jdtls';
  public readonly language = 'java';

  private process: ChildProcess | null = null;
  private channel: JsonRpcChannel | null = null;
  private openedDocuments = new Set<string>();
  private serviceReady = false;

  public async isAvailable(): Promise<boolean> {
    try {
      resolveJdtlsConfig();
      return true;
    } catch {
      return false;
    }
  }

  public async start(workspacePath: string): Promise<void> {
    const { javaBin, launcherJar, configDir } = resolveJdtlsConfig();
    const dataDir = path.join('/tmp', `jdtls_gitnexus_${Date.now()}_${process.pid}`);
    fs.mkdirSync(dataDir, { recursive: true });

    const args = [
      '-Declipse.application=org.eclipse.jdt.ls.core.id1',
      '-Dosgi.bundles.defaultStartLevel=4',
      '-Declipse.product=org.eclipse.jdt.ls.core.product',
      '-Dlog.level=ALL',
      '-noverify',
      '-Xmx2G',
      '-XX:+UseG1GC',
      '-XX:+UseStringDeduplication',
      '--add-modules=ALL-SYSTEM',
      '--add-opens',
      'java.base/java.util=ALL-UNNAMED',
      '--add-opens',
      'java.base/java.lang=ALL-UNNAMED',
      '-jar',
      launcherJar,
      '-configuration',
      configDir,
      '-data',
      dataDir,
    ];

    this.process = spawn(javaBin, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    this.channel = new JsonRpcChannel(this.process);

    const readyPromise = new Promise<void>((resolve) => {
      this.channel!.on('notification', (msg: any) => {
        if (msg.method === 'language/status' && msg.params?.type === 'ServiceReady') {
          this.serviceReady = true;
          resolve();
        }
      });
    });

    const rootUri = pathToFileURL(path.resolve(workspacePath)).toString();
    const initParams = {
      processId: process.pid,
      rootUri,
      capabilities: {
        workspace: { workspaceFolders: true },
        textDocument: {
          callHierarchy: { dynamicRegistration: true },
          documentSymbol: { hierarchicalDocumentSymbolSupport: true },
          definition: { dynamicRegistration: true },
          implementation: { dynamicRegistration: true },
          hover: { dynamicRegistration: true },
        },
      },
      initializationOptions: {
        settings: {
          java: {
            autobuild: { enabled: true },
            import: { gradle: { enabled: true }, maven: { enabled: true } },
          },
        },
      },
    };

    await this.channel.sendRequest('initialize', initParams, 45000);
    this.channel.sendNotification('initialized', {});

    // Wait up to 45 seconds for ServiceReady compilation
    await Promise.race([
      readyPromise,
      new Promise((resolve) => setTimeout(resolve, 35000)),
    ]);
  }

  public async openDocument(filePath: string): Promise<void> {
    const absPath = path.resolve(filePath);
    if (this.openedDocuments.has(absPath) || !this.channel) {
      return;
    }

    if (!fs.existsSync(absPath)) {
      return;
    }

    const uri = pathToFileURL(absPath).toString();
    const text = fs.readFileSync(absPath, 'utf-8');

    this.channel.sendNotification('textDocument/didOpen', {
      textDocument: {
        uri,
        languageId: 'java',
        version: 1,
        text,
      },
    });

    this.openedDocuments.add(absPath);
    // Allow JDT.LS to process document
    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  public async prepareCallHierarchy(
    filePath: string,
    line: number,
    character: number
  ): Promise<CallHierarchyItem[]> {
    if (!this.channel) return [];
    await this.openDocument(filePath);
    const uri = pathToFileURL(path.resolve(filePath)).toString();

    try {
      const res = await this.channel.sendRequest<CallHierarchyItem[]>(
        'textDocument/prepareCallHierarchy',
        {
          textDocument: { uri },
          position: { line, character },
        },
        15000
      );
      return res || [];
    } catch {
      return [];
    }
  }

  public async getOutgoingCalls(item: CallHierarchyItem): Promise<CallHierarchyOutgoingCall[]> {
    if (!this.channel) return [];
    try {
      const res = await this.channel.sendRequest<CallHierarchyOutgoingCall[]>(
        'callHierarchy/outgoingCalls',
        { item },
        15000
      );
      return res || [];
    } catch {
      return [];
    }
  }

  public async getIncomingCalls(item: CallHierarchyItem): Promise<CallHierarchyIncomingCall[]> {
    if (!this.channel) return [];
    try {
      const res = await this.channel.sendRequest<CallHierarchyIncomingCall[]>(
        'callHierarchy/incomingCalls',
        { item },
        15000
      );
      return res || [];
    } catch {
      return [];
    }
  }

  public async findImplementations(
    filePath: string,
    line: number,
    character: number
  ): Promise<LspImplementationResult[]> {
    if (!this.channel) return [];
    await this.openDocument(filePath);
    const uri = pathToFileURL(path.resolve(filePath)).toString();

    try {
      const res = await this.channel.sendRequest<any>(
        'textDocument/implementation',
        {
          textDocument: { uri },
          position: { line, character },
        },
        15000
      );

      if (!res) return [];
      if (Array.isArray(res)) {
        return res.map((r: any) => ({
          uri: r.uri || r.targetUri,
          range: r.range || r.targetRange,
        }));
      }
      return [{ uri: res.uri || res.targetUri, range: res.range || res.targetRange }];
    } catch {
      return [];
    }
  }

  public async getHover(
    filePath: string,
    line: number,
    character: number
  ): Promise<LspHoverResult | null> {
    if (!this.channel) return null;
    await this.openDocument(filePath);
    const uri = pathToFileURL(path.resolve(filePath)).toString();

    try {
      return await this.channel.sendRequest<LspHoverResult>(
        'textDocument/hover',
        {
          textDocument: { uri },
          position: { line, character },
        },
        10000
      );
    } catch {
      return null;
    }
  }

  public async shutdown(): Promise<void> {
    if (this.channel) {
      try {
        await this.channel.sendRequest('shutdown', {}, 5000);
        this.channel.sendNotification('exit', {});
      } catch {
        // Ignore errors during exit
      }
    }
    if (this.process) {
      this.process.kill('SIGTERM');
      this.process = null;
    }
    this.channel = null;
    this.openedDocuments.clear();
  }
}
