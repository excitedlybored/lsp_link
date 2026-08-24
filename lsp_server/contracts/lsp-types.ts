/**
 * LSP Types and Data Transfer Objects for GitNexus LSP Integration.
 */

export interface LspPosition {
  line: number;
  character: number;
}

export interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

export interface LspLocation {
  uri: string;
  range: LspRange;
}

export interface CallHierarchyItem {
  name: string;
  kind: number;
  tags?: number[];
  detail?: string;
  uri: string;
  range: LspRange;
  selectionRange: LspRange;
  containerName?: string;
  data?: unknown;
}

export interface CallHierarchyOutgoingCall {
  to: CallHierarchyItem;
  fromRanges: LspRange[];
}

export interface CallHierarchyIncomingCall {
  from: CallHierarchyItem;
  fromRanges: LspRange[];
}

export interface LspHoverResult {
  contents: string | { language: string; value: string } | Array<string | { language: string; value: string }>;
  range?: LspRange;
}

export interface LspImplementationResult {
  uri: string;
  range: LspRange;
}

export interface LspDocumentSymbol {
  name: string;
  detail?: string;
  kind: number;
  range: LspRange;
  selectionRange: LspRange;
  children?: LspDocumentSymbol[];
}
