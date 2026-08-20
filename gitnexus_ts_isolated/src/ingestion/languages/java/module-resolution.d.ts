/**
 * Java import resolution against DECLARED packages (#2953).
 *
 * A Java import is a fully-qualified type name, not a path. `com.example.model.User`
 * names the type `User` in the package `com.example.model`, and what places a
 * file in that package is its own `package` declaration — not where it sits on
 * disk. A file at `weird/path/User.java` declaring `package com.example.model;`
 * IS `com.example.model.User`; a file at `com/example/model/User.java` declaring
 * nothing is in the DEFAULT package and cannot be imported at all.
 *
 * The previous resolver worked the other way round: it turned dots into slashes
 * and looked for a file whose path ended that way, retrying with each leading
 * segment stripped. Path shape is a convention, so that mostly worked — and
 * failed in the one case that matters most, because it could not tell an import
 * of something outside the repository from one inside it. `java.util.List`
 * became `util/List`, then `List`, and bound to any `List.java` in the tree.
 * Every JDK and third-party import in a repo was a candidate for a fabricated
 * IMPORTS edge at full confidence.
 *
 * The fix needs no new I/O. Every Java file's `package` declaration is already
 * extracted during the parse pass and available here through
 * `getJavaPackageFact` — the resolver simply never read it. So resolution
 * becomes a lookup in an index the workspace already knows how to describe:
 *
 *   `com.example.model.User`  ->  package `com.example.model` declares `User`
 *   `java.util.List`          ->  no file declares package `java.util` -> null
 *
 * `null` for the second is the complete and correct answer: the JDK is not in
 * this repository, so there is no in-repo file the import could name.
 */
import type { ParsedFile } from '../../../../_shared/index.js';
import type { JvmPackageFact } from '../jvm/package-facts.js';
export interface JavaPackageIndex {
    /** Declared package -> importable type name -> the file declaring it. */
    readonly typesByPackage: ReadonlyMap<string, ReadonlyMap<string, string>>;
    /** Declared package -> every file declaring it, for wildcard imports. */
    readonly filesByPackage: ReadonlyMap<string, readonly string[]>;
    /**
     * Files whose `package` header could not be read (a malformed header — see
     * `extractJvmPackageFact`). They are in no package, so nothing can import
     * them; counted so the gap is observable rather than silent.
     */
    readonly unreadablePackageFiles: number;
}
/**
 * Index the workspace by what each file DECLARES.
 *
 * The importable type name is the file's base name, which is not a convention
 * being relied on but the rule the language enforces: a type importable from
 * another package must be `public`, and a public type must live in a file named
 * after it. Additional package-private top-level types in the same file are
 * deliberately not indexed — they are unimportable from elsewhere, so an import
 * naming one is not a resolution this should find.
 */
export declare function buildJavaPackageIndex(parsedFiles: readonly ParsedFile[], packageOf: (filePath: string) => JvmPackageFact | undefined): JavaPackageIndex;
/**
 * Resolve one import specifier to the file(s) it names, or `null`.
 *
 * A wildcard answers with every file in the package; a type import answers with
 * one file. Anything the workspace does not declare answers `null`.
 */
export declare function resolveJavaModule(targetRaw: string, index: JavaPackageIndex): string | readonly string[] | null;
