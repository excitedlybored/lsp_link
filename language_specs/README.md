# Language specs (reference only)

This tree is **not** part of the runtime. Clone upstream repos locally if you need to read JDT.LS, LSP4J, JavaParser, Spring Tools, or the Temporal Java SDK.

```bash
cd language_specs/01_language_server_protocol
git clone --depth 1 https://github.com/eclipse-jdtls/eclipse.jdt.ls.git
git clone --depth 1 https://github.com/eclipse-lsp4j/lsp4j.git

cd ../02_ast_analysis
git clone --depth 1 https://github.com/javaparser/javaparser.git

cd ../03_framework_metamodel_spring
git clone --depth 1 https://github.com/spring-projects/sts4.git spring-tools4

cd ../04_rpc_dynamic_proxy_temporal
git clone --depth 1 https://github.com/temporalio/sdk-java.git temporal-sdk-java
```

Indexing and query code live in `gitnexus_ts_isolated/` and `lsp_server/`.
