import { type SpringNonHttpHandlerFact } from '../../frameworks/spring/non-http-handlers.js';
import { type SyntaxNode } from '../../utils/ast-helpers.js';
import { type JavaAnnotationSyntaxFact } from './spring-di.js';
export type JavaSpringNonHttpHandlerFact = SpringNonHttpHandlerFact<JavaAnnotationSyntaxFact>;
/** Capture callable syntax while the Java class AST is already in hand. */
export declare function captureJavaSpringNonHttpHandlerFacts(classNode: SyntaxNode, filePath: string): JavaSpringNonHttpHandlerFact[];
export declare const attachJavaSpringNonHttpHandlerMetadata: (graph: import("../../../graph/types.js").KnowledgeGraph, parsedFiles: readonly import('../../../../_shared/index.js').ParsedFile[], nodeLookup: import("../../scope-resolution/graph-bridge/node-lookup.js").GraphNodeLookup, indexes: import("../../model/scope-resolution-indexes.js").ScopeResolutionIndexes) => void;
