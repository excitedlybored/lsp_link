import type { LspSymbolNodeTable } from '../model.js';

export type JvmArtifactStageStatus = 'complete' | 'partial' | 'failed';

export interface JvmArtifactEnrichmentRun {
  id: string;
  lspRunId: string;
  status: JvmArtifactStageStatus;
  startedAt: string;
  completedAt?: string;
  provider: 'javap';
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
}

export type JvmEntityKind =
  | 'JvmArtifactEnrichmentRun' | 'JvmArtifact' | 'JvmClass'
  | 'JvmMethod' | 'JvmField' | 'JvmCallSite';

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
  classes: JvmClass[];
  methods: JvmMethod[];
  fields: JvmField[];
  callSites: JvmCallSite[];
  relations: JvmRelation[];
  bindings: LspJvmBinding[];
}

export function emptyJvmArtifactBatch(): JvmArtifactBatch {
  return {
    runs: [], artifacts: [], classes: [], methods: [], fields: [], callSites: [],
    relations: [], bindings: [],
  };
}
