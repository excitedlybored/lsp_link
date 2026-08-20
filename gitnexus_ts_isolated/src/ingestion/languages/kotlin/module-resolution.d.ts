/**
 * Kotlin import resolution against declared packages and module exports (#2960).
 *
 * Kotlin source layout is conventional, not semantic: a file may declare any
 * package from any directory, and a top-level class, function or property need
 * not match the file name. Resolution therefore uses the package fact captured
 * during parsing plus the file's module-scope bindings. It never guesses from a
 * coincidental path suffix.
 */
import type { ParsedFile } from '../../../../_shared/index.js';
import type { JvmPackageFact } from '../jvm/package-facts.js';
export interface KotlinPackageIndex {
    /** Declared package -> top-level exported name -> files declaring that name. */
    readonly declarationsByPackage: ReadonlyMap<string, ReadonlyMap<string, readonly string[]>>;
    /** Declared package -> every file declaring it, for wildcard imports. */
    readonly filesByPackage: ReadonlyMap<string, readonly string[]>;
    /** Files whose package header could not be interpreted conservatively. */
    readonly unreadablePackageFiles: number;
}
export declare function buildKotlinPackageIndex(parsedFiles: readonly ParsedFile[], packageOf: (filePath: string) => JvmPackageFact | undefined): KotlinPackageIndex;
/** Resolve a Kotlin import to the file(s) its declarations name. */
export declare function resolveKotlinModule(targetRaw: string, index: KotlinPackageIndex): string | readonly string[] | null;
