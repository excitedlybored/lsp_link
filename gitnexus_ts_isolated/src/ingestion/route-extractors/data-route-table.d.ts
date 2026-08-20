/**
 * Conservative extraction for explicit JavaScript-style route tables.
 *
 * A generic object containing `path`, `method`, and `handler` can also be an
 * HTTP client request descriptor. Extraction therefore requires both a
 * route-named binding and a static `for (... of table)` dispatch loop whose
 * request guard compares the entry's path and method before directly invoking
 * its handler.
 */
import type Parser from 'tree-sitter';
import type { ExtractedDecoratorRoute } from '../workers/parse-worker.js';
export declare const DATA_ROUTE_TABLE_SOURCE = "data-route-table";
export interface DataRouteTableRoute {
    path: string;
    method: string;
    /** Full static handler designator, e.g. `auth.getCurrentUser`. */
    handlerDesignator: string;
    handlerName: string;
    /** Present only for a bare handler identifier, for named-import resolution. */
    handlerLocalName?: string;
    line: number;
}
/** Return static route facts shared by ingestion and group contract extraction. */
export declare function scanDataRouteTables(tree: Parser.Tree): DataRouteTableRoute[];
export declare function extractDataRouteTableRoutes(tree: Parser.Tree, filePath: string, lineOffset?: number): ExtractedDecoratorRoute[];
