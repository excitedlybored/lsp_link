# JDT.LS scaling research and decisions

This document records the JDT.LS research behind the Java indexing design so
that the conclusions remain available when issue and conversation history is
compacted. It distinguishes verified upstream behavior from proposed changes.

Research date: 2026-08-31

Repository runtime studied: Eclipse JDT.LS 1.57.0, the version currently
vendored under `vendor/jdtls/1.57.0`. Upstream `main` and the 1.60.0 changelog
were also inspected to identify later behavior. Version-specific conclusions
must be revalidated before changing the bundled runtime.

## Executive conclusion

JDT.LS does not provide a setting that divides one Eclipse workspace into
several independent Java indexers. Multiple workspace folders and Eclipse
projects still share one JVM, Eclipse workspace, Java model, and JDT index
manager.

The highest-value scaling change is therefore not arbitrary source-directory
sharding. Use JDT.LS as the authoritative project/classpath host, then load an
OSGi extension that performs bounded batch JDT Core analysis. A batch traversal
can collect declarations, binding identities, occurrences, calls, type
relationships, ranges, and diagnostics while parsing each compilation unit
once. Incoming references and calls can then be derived by reversing the
collected outgoing observations instead of issuing one global LSP search per
declaration.

Target-aware multi-process partitioning remains a later option when one
batch-enabled process is still insufficient. It must preserve Bazel ownership,
dependency closure, URI identity, and cross-partition evidence.

## Verified behavior in JDT.LS 1.57.0

### `java.project.getClasspaths` implicitly waits for the global index

JDT.LS routes `workspace/executeCommand` through
`JDTLanguageServer.executeCommand`. In 1.57.0, every command except two editing
commands first calls:

```java
JavaModelManager.getIndexManager().waitForIndex(true, null);
```

Only after that wait does JDT.LS invoke the delegate command handler. The
`java.project.getClasspaths` implementation itself reads the owning Java
project's launch classpath and module path, but the global wait occurs before
that implementation is reached.

Consequences for this repository:

- The telemetry phase named `classpath-readiness` includes JDT source and JAR
  indexing time. It is not primarily the cost of comparing path strings.
- A long `workspace/executeCommand` request for `java.project.getClasspaths`
  is also acting as an index-readiness barrier.
- Client cancellation cannot interrupt this particular wait because JDT.LS
  passes a null progress monitor to `waitForIndex`.
- The local JSON-RPC deadline prevents the Node process from awaiting the
  response indefinitely, but the Java-side operation may continue after the
  client promise has rejected.
- Removing the classpath request does not remove the need for a ready search
  index when the crawl subsequently asks for global references. It can merely
  move the wait into the first search request.

Sources:

- [JDTLanguageServer.executeCommand in v1.57.0](https://github.com/eclipse-jdtls/eclipse.jdt.ls/blob/v1.57.0/org.eclipse.jdt.ls.core/src/org/eclipse/jdt/ls/core/internal/handlers/JDTLanguageServer.java)
- [ProjectCommand classpath implementation in v1.57.0](https://github.com/eclipse-jdtls/eclipse.jdt.ls/blob/v1.57.0/org.eclipse.jdt.ls.core/src/org/eclipse/jdt/ls/core/internal/commands/ProjectCommand.java)
- [Registered JDT delegate commands in v1.57.0](https://github.com/eclipse-jdtls/eclipse.jdt.ls/blob/v1.57.0/org.eclipse.jdt.ls.core/plugin.xml)

Upstream `main` now exempts a small allowlist of project-tree commands from the
global index wait. At the research date, `java.project.getClasspaths` is not in
that allowlist, so upgrading alone does not remove this behavior.

- [Current upstream command dispatch](https://github.com/eclipse-jdtls/eclipse.jdt.ls/blob/main/org.eclipse.jdt.ls.core/src/org/eclipse/jdt/ls/core/internal/handlers/JDTLanguageServer.java)

### A standard references request searches the Java workspace

In 1.57.0, `ReferencesHandler` obtains all Java projects in the Eclipse
workspace and creates a JDT search scope containing their sources, referenced
projects, and application libraries. It then invokes the JDT `SearchEngine`.

The current crawler asks for references at each discovered symbol position.
Most positions are distinct, so the session RPC cache cannot combine them. At
large declaration counts this creates repeated global searches:

```text
declaration 1 -> workspace reference search
declaration 2 -> workspace reference search
declaration 3 -> workspace reference search
...
```

This search amplification is more significant than JSON-RPC serialization.

Sources:

- [ReferencesHandler in v1.57.0](https://github.com/eclipse-jdtls/eclipse.jdt.ls/blob/v1.57.0/org.eclipse.jdt.ls.core/src/org/eclipse/jdt/ls/core/internal/handlers/ReferencesHandler.java)
- [Eclipse JDT SearchEngine API](https://help.eclipse.org/latest/topic/org.eclipse.jdt.doc.isv/reference/api/org/eclipse/jdt/core/search/SearchEngine.html)
- [Using the JDT Java search engine](https://help.eclipse.org/latest/topic/org.eclipse.jdt.doc.isv/guide/jdt_api_search.htm)

The newer `projectOnly` search-scope behavior excludes application and system
libraries from relevant searches, but it does not divide one workspace into
independent index managers. JDT.LS 1.57.0 supports only the older `all` and
`main` scope values, so this optimization is not currently available in the
vendored runtime.

### Multi-root is organization, not process parallelism

JDT.LS accepts multiple workspace folders during initialization and supports
`workspace/didChangeWorkspaceFolders` plus
`java.project.changeImportedProjects`. These operations import or remove
Eclipse projects inside the same Eclipse workspace. Workspace update jobs use
Eclipse scheduling rules and do not create independent compiler/index
processes.

Sources:

- [Initialization workspace-folder handling](https://github.com/eclipse-jdtls/eclipse.jdt.ls/blob/v1.57.0/org.eclipse.jdt.ls.core/src/org/eclipse/jdt/ls/core/internal/handlers/BaseInitHandler.java)
- [ProjectsManager dynamic import handling](https://github.com/eclipse-jdtls/eclipse.jdt.ls/blob/v1.57.0/org.eclipse.jdt.ls.core/src/org/eclipse/jdt/ls/core/internal/managers/ProjectsManager.java)

### `java.maxConcurrentBuilds` does not control semantic requests

`java.maxConcurrentBuilds` sets the Eclipse workspace's maximum concurrent
project builds and configures Maven builder scheduling. It does not configure
the JDT search index, JSON-RPC request executor, AST parser concurrency, or the
number of JDT.LS processes.

The generated Bazel/Eclipse mode disables Eclipse autobuild, so increasing this
value should not materially improve the Bazel semantic crawl.

Sources:

- [StandardPreferenceManager parallel-build setting](https://github.com/eclipse-jdtls/eclipse.jdt.ls/blob/v1.57.0/org.eclipse.jdt.ls.core/src/org/eclipse/jdt/ls/core/internal/preferences/StandardPreferenceManager.java)
- [Official VS Code Java setting](https://github.com/redhat-developer/vscode-java/blob/main/package.json)

### JDT.LS can execute semantic requests asynchronously

Most semantic handlers return `CompletableFuture` values and use LSP4J's
asynchronous computation helpers. JDT.LS can therefore accept more than one
outstanding request. Eclipse workspace scheduling rules, document lifecycle
jobs, and the shared search index can still serialize or contend internally.

The repository's `JavaJdtlsAdapter.maxConcurrentRequests = 1` is a client-side
correctness policy, not a JDT.LS protocol requirement. Raising it globally is
unsafe; a future scheduler should distinguish workspace mutations, document
lifecycle operations, AST-local reads, and global searches.

Source:

- [BaseJDTLanguageServer asynchronous request helper](https://github.com/eclipse-jdtls/eclipse.jdt.ls/blob/v1.57.0/org.eclipse.jdt.ls.core/src/org/eclipse/jdt/ls/core/internal/BaseJDTLanguageServer.java)

### JDT.LS exposes real Eclipse-job progress

JDT.LS installs a progress provider for Eclipse jobs and can report progress
through standard `$/progress` notifications or the legacy
`language/progressReport` notification. Reports can contain task, subtask,
total work, completed work, completion state, and percentage. System jobs and
jobs without meaningful totals may remain opaque.

The current adapter primarily uses `language/status` for startup phase changes.
It should record JDT progress notifications so a long index/import wait reports
the task JDT is actually performing.

Sources:

- [ProgressReporterManager in v1.57.0](https://github.com/eclipse-jdtls/eclipse.jdt.ls/blob/v1.57.0/org.eclipse.jdt.ls.core/src/org/eclipse/jdt/ls/core/internal/handlers/ProgressReporterManager.java)
- [JavaClientConnection progress notifications](https://github.com/eclipse-jdtls/eclipse.jdt.ls/blob/v1.57.0/org.eclipse.jdt.ls.core/src/org/eclipse/jdt/ls/core/internal/JavaClientConnection.java)

### Shared indexes reuse external-library indexes only

JDT.LS supports the JVM system property:

```text
-Djdt.core.sharedIndexLocation=/persistent/path
```

The implementation copies and reuses indexes for external JAR classpath
entries. It explicitly skips non-external JARs and does not provide a shared
repository-source index. This can reduce repeated work for common dependency
JARs across runs and shards, but it cannot eliminate cold indexing of the
repository's Java sources.

Sources:

- [JDT.LS IndexUtils shared-index implementation](https://github.com/eclipse-jdtls/eclipse.jdt.ls/blob/v1.57.0/org.eclipse.jdt.ls.core/src/org/eclipse/jdt/ls/core/internal/handlers/IndexUtils.java)
- [VS Code Java shared-index launcher configuration](https://github.com/redhat-developer/vscode-java/blob/main/src/javaServerStarter.ts)
- [VS Code Java shared-index settings](https://github.com/redhat-developer/vscode-java/blob/main/package.json)

### JDT `-data` is intended to be workspace-specific state

The official launcher requires an absolute `-data` directory and says it
contains workspace-specific information and should be unique per
workspace/project. It does not require the directory to be deleted after each
run. Normal editor integrations retain workspace state and clean it according
to a cache policy.

This repository currently recreates JDT's mutable `-data` for every run. An
earlier persistence experiment made the full warm crawl slower, so persistence
was removed. That result must not be interpreted as proof that all persistent
state is inherently slow: run-scoped generated Eclipse project paths can force
a restored workspace to reconcile stale locations. A valid follow-up experiment
must stabilize the generated project paths and `-data` identity together and
validate them against source-inventory, classpath, runtime, and configuration
hashes.

Sources:

- [Official JDT.LS command-line launcher instructions](https://github.com/eclipse-jdtls/eclipse.jdt.ls#running-from-the-command-line)
- [VS Code Java workspace cache configuration](https://github.com/redhat-developer/vscode-java/blob/main/package.json)

### The syntax server is deliberately source-light

JDT.LS contains a separate lightweight syntax-server product. It supports
document symbols, syntax diagnostics, semantic tokens, hover, definition/type
definition, formatting, folding, selection ranges, and related document-local
features. It does not replace the standard server's complete global references,
implementations, build model, and call/type hierarchy behavior.

It could accelerate or parallelize a structural-only pass, but a full semantic
index still requires the standard server or another binding-aware compiler
stage.

Sources:

- [SyntaxLanguageServer in v1.57.0](https://github.com/eclipse-jdtls/eclipse.jdt.ls/blob/v1.57.0/org.eclipse.jdt.ls.core/src/org/eclipse/jdt/ls/core/internal/syntaxserver/SyntaxLanguageServer.java)
- [JDT.LS syntax-server product](https://github.com/eclipse-jdtls/eclipse.jdt.ls/blob/v1.57.0/org.eclipse.jdt.ls.product/syntaxServer.product)

### JDT.LS supports OSGi extension bundles

Clients can load OSGi bundles through `initializationOptions.bundles`. Bundles
can contribute delegate command handlers and other JDT.LS extension points.
This is an established mechanism used by Java debugging and related Java tools;
the repository already supplies Spring-related JDT bundles through the same
initialization option.

Sources:

- [JDT.LS delegate-command extension point](https://github.com/eclipse-jdtls/eclipse.jdt.ls/blob/v1.57.0/org.eclipse.jdt.ls.core/plugin.xml)
- [JDT.LS feature and extensibility overview](https://github.com/eclipse-jdtls/eclipse.jdt.ls)

## Recommended batch-index extension

Create a small, version-pinned OSGi bundle loaded beside the existing Spring
bundles. It should expose a bounded command such as:

```text
gitnexus.java.indexProjectBatch
```

The command should accept one Eclipse project and a bounded set of owned
compilation units. It should write a streamed result file and return a compact
manifest rather than returning millions of observations in one JSON-RPC
response.

JDT Core's `ASTParser.createASTs` is designed for batch compilation-unit
processing. Its API documentation states that binding resolution across a
batch is more efficient because work can be shared. All compilation units in a
binding-resolved batch must belong to the same Java project, which matches the
generated Eclipse-project boundary.

Sources:

- [Eclipse JDT ASTParser API](https://help.eclipse.org/latest/topic/org.eclipse.jdt.doc.isv/reference/api/org/eclipse/jdt/core/dom/ASTParser.html)
- [Eclipse JDT ASTRequestor API](https://help.eclipse.org/latest/topic/org.eclipse.jdt.doc.isv/reference/api/org/eclipse/jdt/core/dom/ASTRequestor.html)

The batch visitor should emit at least:

- Declarations with stable JDT binding keys and source ranges.
- Type, method, constructor, field, annotation, and package occurrences.
- Method/constructor invocation targets and enclosing callable identities.
- Field read/write roles.
- Superclass and implemented-interface relationships.
- Lambda and method-reference targets when bindings resolve.
- Diagnostics and recovered/unresolved-binding counters.
- Canonical source URI plus the physical JDT URI as provenance.

Process compilation units in bounded batches, initially 100 to 500 documents,
and release AST and binding objects immediately after serialization. JDT warns
that binding-enabled ASTs consume significant time and memory and should not be
retained longer than necessary.

Global relationships can then be derived without repeated reverse searches:

```text
all outgoing symbol occurrences -> group by target binding -> references
all outgoing calls              -> reverse target edge    -> incoming calls
all subtype declarations        -> reverse super edge     -> implementations
```

JDT search requests remain useful for validation and genuinely search-specific
features, but they should no longer be the primary mechanism for enumerating
every repository occurrence.

## Staged implementation priorities

1. Correct telemetry terminology: separate `jdt-index-readiness` from
   `classpath-validation`.
2. Capture and report `$/progress` and `language/progressReport`.
3. Add an isolated persistent external-JAR shared-index location and measure
   cold/warm behavior.
4. Benchmark the current `-XX:TieredStopAtLevel=1` against normal tiered JIT;
   it favors JVM startup and may hurt a long compiler/indexing workload.
5. Prototype the batch extension for declarations, binding identities, method
   calls, and type references.
6. Compare batch output with the current exhaustive LSP crawl on samples and a
   larger synthetic repository.
7. Replace per-symbol reference enumeration with occurrence-derived reverse
   relationships once completeness is demonstrated.
8. Re-evaluate persistent JDT state using stable Eclipse-project and `-data`
   paths keyed by source inventory, classpath, JDT version, and configuration.
9. Add capability-specific request scheduling only after correctness and
   memory benchmarks.
10. Add target-aware multi-process partitions only if a batch-enabled single
    process remains insufficient.

## Required acceptance evidence

Do not accept a performance improvement based only on elapsed time. Record:

- Expected and processed documents per Eclipse project.
- Declarations and occurrences per document.
- Resolved, recovered, and unresolved bindings.
- Source, generated-source, source-JAR, and binary URI round trips.
- Cross-project definitions, references, calls, and implementations.
- Spring project and structure observations.
- JDT progress tasks, index-wait duration, classpath-validation duration, and
  batch traversal duration.
- JDT heap/RSS, Node RSS, output buffering, and graph-publication peak RSS.
- Cold, unchanged-warm, implementation-change, and ABI-change runs.
- Differences against the existing single-process exhaustive baseline, with
  every difference classified rather than silently tolerated.

## Explicit non-solutions

- Raising `java.maxConcurrentBuilds` does not parallelize semantic indexing.
- Adding workspace folders does not create independent JDT index managers.
- Removing the classpath-parity request only moves the index wait when global
  semantic searches still follow.
- Increasing every LSP request to concurrency four can increase contention and
  memory without improving throughput.
- Shared indexes do not cache repository source indexes.
- The syntax server cannot replace full semantic processing.
- Arbitrary directory sharding can silently lose cross-module semantics.

## Version notes

The repository currently pins JDT.LS 1.57.0. The upstream changelog records
later progress and performance changes, including progressive project-import
notifications in 1.58.0. Any upgrade must be tested with generated Eclipse
projects, URI mapping, Spring bundles, classpath commands, and live sample
crawls before replacing the pinned runtime.

Source:

- [JDT.LS changelog](https://github.com/eclipse-jdtls/eclipse.jdt.ls/blob/main/CHANGELOG.md)
