/**
 * Adapter from `(ParsedImport, WorkspaceIndex)` to Kotlin declared-package
 * resolution. Package facts and module bindings are already present on the
 * parsed workspace, so this performs no source I/O and no path inference.
 */
import type { ParsedFile, ParsedImport, WorkspaceIndex } from '../../../../_shared/index.js';
export interface KotlinResolveContext {
    readonly fromFile: string;
    readonly allFilePaths: ReadonlySet<string>;
    /** Stable parsed-workspace identity supplied by the resolution pass. */
    readonly parsedFiles?: readonly ParsedFile[];
}
export declare function resolveKotlinImportTarget(parsedImport: ParsedImport, workspaceIndex: WorkspaceIndex): string | readonly string[] | null;
