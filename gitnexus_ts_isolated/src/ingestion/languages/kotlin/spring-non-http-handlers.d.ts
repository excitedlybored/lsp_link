import { type SpringNonHttpHandlerAnnotationFact, type SpringNonHttpHandlerFact } from '../../frameworks/spring/non-http-handlers.js';
import { type SyntaxNode } from '../../utils/ast-helpers.js';
export type KotlinSpringNonHttpHandlerFact = SpringNonHttpHandlerFact<SpringNonHttpHandlerAnnotationFact>;
/**
 * Capture annotated callables conservatively. A simple-name prefilter would
 * discard Kotlin aliases (for example, `EventListener as SpringEvent`) before
 * the post-import resolver can map the local name back to its annotation FQN.
 */
export declare function captureKotlinSpringNonHttpHandlerFacts(classNode: SyntaxNode, filePath: string): KotlinSpringNonHttpHandlerFact[];
export declare const attachKotlinSpringNonHttpHandlerMetadata: (graph: import("../../../graph/types.js").KnowledgeGraph, parsedFiles: readonly import('../../../../_shared/index.js').ParsedFile[], nodeLookup: import("../../scope-resolution/graph-bridge/node-lookup.js").GraphNodeLookup, indexes: import("../../model/scope-resolution-indexes.js").ScopeResolutionIndexes) => void;
