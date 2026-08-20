/**
 * Adapter from `(ParsedImport, WorkspaceIndex)` to Kotlin declared-package
 * resolution. Package facts and module bindings are already present on the
 * parsed workspace, so this performs no source I/O and no path inference.
 */
import { perFileSet } from '../../import-resolvers/per-file-set.js';
import { getKotlinPackageFact } from './package-facts.js';
import { buildKotlinPackageIndex, resolveKotlinModule, } from './module-resolution.js';
const getKotlinPackageIndex = perFileSet((parsedFiles) => buildKotlinPackageIndex(parsedFiles, getKotlinPackageFact));
export function resolveKotlinImportTarget(parsedImport, workspaceIndex) {
    const ctx = narrowContext(workspaceIndex);
    if (ctx === null || parsedImport.kind === 'dynamic-unresolved')
        return null;
    if (parsedImport.targetRaw === null || parsedImport.targetRaw === '')
        return null;
    const parsedFiles = ctx.parsedFiles;
    if (parsedFiles === undefined || parsedFiles.length === 0)
        return null;
    return resolveKotlinModule(parsedImport.targetRaw, getKotlinPackageIndex(parsedFiles));
}
function narrowContext(workspaceIndex) {
    const ctx = workspaceIndex;
    if (ctx === undefined ||
        typeof ctx.fromFile !== 'string' ||
        !(ctx.allFilePaths instanceof Set)) {
        return null;
    }
    return ctx;
}
