/**
 * Pluggable LSP Adapter Interface.
 *
 * Every language-specific LSP adapter (Java/JDT.LS, Go/Gopls, Rust/Rust-Analyzer, etc.)
 * implements this contract.
 */

import {
  CallHierarchyItem,
  CallHierarchyOutgoingCall,
  CallHierarchyIncomingCall,
  LspHoverResult,
  LspImplementationResult,
} from './lsp-types.js';

export interface ILspAdapter {
  /** Identifier of the language server (e.g. 'jdtls', 'gopls', 'rust-analyzer') */
  readonly id: string;

  /** Target programming language (e.g. 'java', 'go', 'rust', 'typescript') */
  readonly language: string;

  /** Checks if the required language runtime & binary is available on the system */
  isAvailable(): Promise<boolean>;

  /** Starts the language server and performs the initialize/initialized handshake */
  start(workspacePath: string): Promise<void>;

  /** Ensures target document is opened in the language server */
  openDocument(filePath: string): Promise<void>;

  /** Prepares call hierarchy items at target position */
  prepareCallHierarchy(filePath: string, line: number, character: number): Promise<CallHierarchyItem[]>;

  /** Retrieves outgoing calls for a given call hierarchy item */
  getOutgoingCalls(item: CallHierarchyItem): Promise<CallHierarchyOutgoingCall[]>;

  /** Retrieves incoming calls for a given call hierarchy item */
  getIncomingCalls(item: CallHierarchyItem): Promise<CallHierarchyIncomingCall[]>;

  /** Finds concrete implementations of an interface / method at target position */
  findImplementations(filePath: string, line: number, character: number): Promise<LspImplementationResult[]>;

  /** Retrieves type information / doc hover at target position */
  getHover(filePath: string, line: number, character: number): Promise<LspHoverResult | null>;

  /** Shuts down the language server process cleanly */
  shutdown(): Promise<void>;
}
