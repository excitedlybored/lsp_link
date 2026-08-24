/**
 * Pluggable LSP Adapter Interface.
 *
 * Every language-specific adapter (JDT.LS, gopls, rust-analyzer, …) implements
 * this contract so the enricher can start a server, query symbols, and shut down.
 */

import {
  CallHierarchyItem,
  CallHierarchyOutgoingCall,
  CallHierarchyIncomingCall,
  LspHoverResult,
  LspImplementationResult,
} from './lsp-types.js';

export interface ILspAdapter {
  /** Language server id (e.g. 'jdtls', 'gopls', 'rust-analyzer') */
  readonly id: string;

  /** Target language (e.g. 'java', 'go', 'rust', 'typescript') */
  readonly language: string;

  /**
   * Max in-flight RPCs against this server.
   * Compilers that serialize internally (JDT.LS, OmniSharp, clangd) should use 1.
   */
  readonly maxConcurrentRequests: number;

  /** Session identity used to preserve build-root and workspace provenance. */
  getSessionMetadata(): { workspacePath?: string; buildRootId?: string; buildSystems?: string[] };

  isAvailable(): Promise<boolean>;

  /** Spawn the server and complete initialize / initialized. */
  start(workspacePath: string): Promise<void>;

  openDocument(filePath: string): Promise<void>;

  /** didClose so the compiler working set stays bounded. */
  closeDocument(filePath: string): Promise<void>;

  prepareCallHierarchy(filePath: string, line: number, character: number): Promise<CallHierarchyItem[]>;

  getOutgoingCalls(item: CallHierarchyItem): Promise<CallHierarchyOutgoingCall[]>;

  getIncomingCalls(item: CallHierarchyItem): Promise<CallHierarchyIncomingCall[]>;

  findImplementations(filePath: string, line: number, character: number): Promise<LspImplementationResult[]>;

  getHover(filePath: string, line: number, character: number): Promise<LspHoverResult | null>;

  shutdown(): Promise<void>;
}
