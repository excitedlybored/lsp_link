import type { ParsedFile, Range, ScopeId } from '../../../../_shared/index.js';
import type { KnowledgeGraph } from '../../../graph/types.js';
import type { ScopeResolutionIndexes } from '../../model/scope-resolution-indexes.js';
import type { GraphNodeLookup } from '../../scope-resolution/graph-bridge/node-lookup.js';
export declare const SPRING_NON_HTTP_HANDLER_ENTRY_POINT_MULTIPLIER = 3;
export type SpringNonHttpHandlerKind = 'scheduled' | 'event' | 'message' | 'xxl-job';
export interface SpringNonHttpHandlerAnnotationFact {
    readonly name: string;
    /** Kotlin use-site targets describe generated/property elements, not the callable. */
    readonly useSiteTarget?: string;
}
export interface SpringNonHttpHandlerFact<Annotation extends SpringNonHttpHandlerAnnotationFact = SpringNonHttpHandlerAnnotationFact> {
    readonly ownerScopeId: ScopeId;
    readonly ownerFilePath?: string;
    /** Exact syntax range used only as a fail-closed bridge for collapsed language scopes. */
    readonly ownerRange?: Range;
    readonly annotations: readonly Annotation[];
}
export interface SpringNonHttpHandlerAdapter<Annotation extends SpringNonHttpHandlerAnnotationFact> {
    getFacts(filePath: string): readonly SpringNonHttpHandlerFact<Annotation>[];
    isPackageVisibilityIncomplete(filePath: string): boolean;
}
export declare function hasSpringNonHttpHandlerRelevantAnnotation(annotations: readonly Pick<SpringNonHttpHandlerAnnotationFact, 'name'>[]): boolean;
/**
 * Resolve callable annotations after imports and package visibility finalize,
 * then promote confirmed framework-managed handlers into process entry points.
 */
export declare function createSpringNonHttpHandlerMetadataAttacher<Annotation extends SpringNonHttpHandlerAnnotationFact>(adapter: SpringNonHttpHandlerAdapter<Annotation>): (graph: KnowledgeGraph, parsedFiles: readonly ParsedFile[], nodeLookup: GraphNodeLookup, indexes: ScopeResolutionIndexes) => void;
