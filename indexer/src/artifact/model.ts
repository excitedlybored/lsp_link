import type { LspSymbolNodeTable } from '../model.js';
import type { CodeOrigin } from '../code-origin.js';

export type JvmArtifactStageStatus = 'running' | 'complete' | 'partial' | 'failed';

export interface JvmArtifactEnrichmentRun {
  id: string;
  lspRunId: string;
  status: JvmArtifactStageStatus;
  startedAt: string;
  completedAt?: string;
  provider: 'asm';
  providerVersion?: string;
  classpathProviders: string[];
  classpathResolutionJson: string;
  classpathErrorCount: number;
  artifactCount: number;
  classCount: number;
  methodCount: number;
  fieldCount: number;
  callSiteCount: number;
  errorCount: number;
  truncated: boolean;
}

export interface JvmArtifact {
  id: string;
  stageId: string;
  buildRootIds: string[];
  classpathProviders: string[];
  classpathScopes: string[];
  modulePath: boolean;
  coordinate?: string;
  classpathEntryPath: string;
  headerJarPath?: string;
  binaryJarPath?: string;
  sourceJarPath?: string;
  sourceOrigin: 'provided' | 'local_maven' | 'sibling' | 'downloaded' | 'unavailable';
  associationStatus: 'complete' | 'binary_only' | 'header_only';
  classCount: number;
  methodCount: number;
  fieldCount: number;
  callSiteCount: number;
  contentHash: string;
  classpathOrdinal: number;
  codeOrigin: CodeOrigin;
  processingStatus: 'pending' | 'running' | 'complete' | 'partial' | 'failed';
  errorCount: number;
  completedAt?: string;
}

export interface JvmClassResolution {
  binaryName: string;
  stageId: string;
  classId: string;
  artifactId: string;
  classpathOrdinal: number;
}

export interface JvmBinaryReference {
  binaryName: string;
  stageId: string;
}

export interface JvmBinaryReferenceRelation {
  id: string;
  binaryName: string;
  targetKind: 'JvmClass' | 'JvmCallSite';
  targetId: string;
  kind: 'SUPERCLASS_TARGET' | 'INTERFACE_TARGET' | 'BYTECODE_CALL_TARGET';
  stageId: string;
  ordinal: number;
}

export interface JvmClass {
  id: string;
  stageId: string;
  artifactId: string;
  binaryName: string;
  packageName: string;
  simpleName: string;
  kind: 'class' | 'interface' | 'enum' | 'annotation' | 'record' | 'unknown';
  access?: string;
  superName?: string;
  interfaces: string[];
  sourceEntry?: string;
  isSeed: boolean;
  seedUris: string[];
  wasDisassembled: boolean;
  annotations: string[];
  codeOrigin: CodeOrigin;
}

export interface JvmMethod {
  id: string;
  stageId: string;
  classId: string;
  owner: string;
  name: string;
  descriptor: string;
  declaration?: string;
  access?: string;
  hasCode: boolean;
  isExternalPlaceholder: boolean;
  annotations: string[];
  codeOrigin: CodeOrigin;
}

export interface JvmField {
  id: string;
  stageId: string;
  classId: string;
  owner: string;
  name: string;
  descriptor: string;
  declaration?: string;
  access?: string;
  annotations: string[];
  codeOrigin: CodeOrigin;
}

export interface JvmCallSite {
  id: string;
  stageId: string;
  callerMethodId: string;
  bytecodeOffset: number;
  opcode: string;
  targetOwner: string;
  targetName: string;
  targetDescriptor: string;
  status: 'resolved' | 'external' | 'unresolved';
  codeOrigin: CodeOrigin;
}

export type JvmEntityKind =
  | 'JvmArtifactEnrichmentRun' | 'JvmArtifact' | 'JvmClassResolution' | 'JvmClass'
  | 'JvmBinaryReference' | 'JvmMethod' | 'JvmField' | 'JvmCallSite';

export interface JvmRelation {
  id: string;
  sourceKind: JvmEntityKind;
  sourceId: string;
  targetKind: JvmEntityKind;
  targetId: string;
  kind: 'HAS_ARTIFACT' | 'CONTAINS_CLASS' | 'DECLARES_METHOD' | 'DECLARES_FIELD'
    | 'BYTECODE_SUPERCLASS' | 'BYTECODE_INTERFACE'
    | 'HAS_BYTECODE_CALLSITE' | 'BYTECODE_RESOLVES_TO';
  stageId: string;
  status: 'observed' | 'resolved' | 'external';
  ordinal?: number;
}

export type LspJvmBindingSourceKind = 'LspHover' | 'LspOccurrence' | LspSymbolNodeTable;

export interface LspJvmBinding {
  id: string;
  sourceKind: LspJvmBindingSourceKind;
  sourceId: string;
  targetKind: 'JvmClass' | 'JvmMethod';
  targetId: string;
  kind: 'HOVER_TARGET' | 'SYMBOL_OWNER' | 'SYMBOL_IDENTITY' | 'OCCURRENCE_TARGET';
  stageId: string;
  status: 'resolved';
  confidence: number;
  reason: string;
}

export interface JvmArtifactBatch {
  runs: JvmArtifactEnrichmentRun[];
  artifacts: JvmArtifact[];
  resolutions: JvmClassResolution[];
  binaryReferences: JvmBinaryReference[];
  binaryReferenceRelations: JvmBinaryReferenceRelation[];
  classes: JvmClass[];
  methods: JvmMethod[];
  fields: JvmField[];
  callSites: JvmCallSite[];
  relations: JvmRelation[];
  bindings: LspJvmBinding[];
}

export interface JvmArtifactEnrichmentSummary {
  run: JvmArtifactEnrichmentRun;
  sourceAssociatedArtifactCount: number;
}

export function emptyJvmArtifactBatch(): JvmArtifactBatch {
  return {
    runs: [], artifacts: [], resolutions: [], binaryReferences: [], binaryReferenceRelations: [],
    classes: [], methods: [], fields: [], callSites: [],
    relations: [], bindings: [],
  };
}
