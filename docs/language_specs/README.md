# Language specs (reference only)

This documentation tree is **not** part of the runtime. Clone upstream repos
locally if you need to read JDT.LS, LSP4J, JavaParser, Spring Tools, or the
Temporal Java SDK. The cloned repositories are ignored by Git.

```bash
cd docs/language_specs
mkdir -p 01_language_server_protocol 02_ast_analysis \
  03_framework_metamodel_spring 04_rpc_dynamic_proxy_temporal

cd 01_language_server_protocol
git clone --depth 1 https://github.com/eclipse-jdtls/eclipse.jdt.ls.git
git clone --depth 1 https://github.com/eclipse-lsp4j/lsp4j.git

cd ../02_ast_analysis
git clone --depth 1 https://github.com/javaparser/javaparser.git

cd ../03_framework_metamodel_spring
git clone --depth 1 https://github.com/spring-projects/sts4.git spring-tools4

cd ../04_rpc_dynamic_proxy_temporal
git clone --depth 1 https://github.com/temporalio/sdk-java.git temporal-sdk-java
```

Indexing lives in `indexer/`, language-server integration in `lsp_server/`, and
read-only queries in `analyzer/`. The public flow that orchestrates those
components is always `./lsp-link index /path/to/repository`; these cloned
reference repositories never participate in that runtime flow.
