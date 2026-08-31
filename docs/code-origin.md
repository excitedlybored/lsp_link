# Code-origin classification

`codeOrigin` identifies who owns a code-bearing database node and which stage
produced it. It is an explicit, stable string field for filtering architecture
views, search results, extraction inputs, and dependency traversals.

| Value | Definition | Typical examples |
| --- | --- | --- |
| `repository` | First-party source stored in the indexed repository and normally editable by its developers. | `src/main/java/...`, checked-in tests, repository-owned QA and simulator source |
| `generated_first_party` | First-party source generated from repository-owned inputs during preparation or the build. It belongs to the application but normally should not be edited directly. | Protobuf/OpenAPI output, annotation-generated Java, generated Bazel source |
| `first_party_artifact` | Compiled output produced for repository-owned targets or build roots. This is first-party bytecode evidence rather than source evidence. | Application JARs and classes emitted under Maven `target`, Gradle `build`, or main-repository Bazel output |
| `third_party_dependency` | Code supplied by an external dependency and consumed by the repository. | Maven/Gradle cache JARs, external Bazel artifacts, framework and vendor libraries |
| `standard_library` | Code supplied by the language/runtime platform rather than the repository or a package dependency. | JDK runtime classes and standard modules |
| `unknown` | Ownership cannot be established from available repository, build, path, provider, or coordinate evidence. It must not be assumed to be first-party. | An opaque JAR from an explicit manifest with no coordinate or ownership path |

The values are mutually exclusive for one persisted node. They describe
ownership, not quality or relevance. A third-party class can still be essential
to resolving a first-party call.

## Default user-facing scope

Repository-focused views should normally start with:

```text
repository
generated_first_party
first_party_artifact
```

Dependency and platform nodes remain supporting evidence:

```text
third_party_dependency
standard_library
unknown
```

Filter the starting nodes rather than deleting supporting nodes. Explicit
traversal into dependencies keeps calls, inheritance, annotations, and type
resolution explainable.

## Persistence

`codeOrigin` is stored on:

- `LspDocument` and all 26 concrete `Lsp*Symbol` tables;
- `JvmArtifact`, `JvmClass`, `JvmMethod`, `JvmField`, and `JvmCallSite`;
- `BazelTarget`, `BazelSource`, and `BazelArtifact`.

JVM classes and members inherit the origin of their containing `JvmArtifact`.
Bazel target artifacts are first-party because they are direct outputs reported
for configured main-repository targets. An LSP symbol inherits its document's
origin.

`Lsp*Symbol.isExternal` remains as a compatibility convenience. It is `false`
for `repository`, `generated_first_party`, and `first_party_artifact`; it is
`true` for `third_party_dependency`, `standard_library`, and `unknown`.

## Classification rules

Classification is evidence-based and conservative:

1. Source physically owned by the workspace is `repository`.
2. Configured generated source or selected main-repository source-JAR content
   is `generated_first_party`.
3. An artifact under its build-root workspace, or a non-external
   main-repository Bazel output, is `first_party_artifact`.
4. A recognized Maven/Gradle cache coordinate or external-repository path is
   `third_party_dependency`.
5. A recognized JDK runtime location is `standard_library`.
6. Insufficient or conflicting evidence produces `unknown`.

Artifact classification happens before cache retention, so the indexer's cache
path cannot erase original ownership evidence.

## Query examples

```cypher
MATCH (document:LspDocument)
RETURN document.codeOrigin, count(document) AS documents
ORDER BY document.codeOrigin
```

```cypher
MATCH (class:JvmClass)
WHERE class.codeOrigin IN ['first_party_artifact']
RETURN class.binaryName, class.codeOrigin
```

```cypher
MATCH (artifact:JvmArtifact)
WHERE artifact.codeOrigin IN ['third_party_dependency', 'standard_library', 'unknown']
RETURN artifact.coordinate, artifact.binaryJarPath, artifact.codeOrigin
```
