# Rule-based analyzer

This folder contains read-only, framework-specific analysis over the LSP-native
LadybugDB schema. Rules never parse source and never mutate the database.

## Layout

```text
analyzer/rules/
  core.py                    generic query-pack engine
  run.py                     CLI
  packs/
    temporal/
      pack.json              manifest and ordered query list
      queries/*.cypher       inspectable LadybugDB rules
      assembler.py           converts query evidence into workflows
```

A Kafka, Spring, gRPC, or persistence pack gets its own sibling directory. It
can reuse the engine while keeping its vocabulary, queries, confidence rules,
and assembler isolated.

## Temporal

```bash
uv run --with 'ladybug==0.19.1' python -m analyzer.rules.run \
  /tmp/bazel-springboot-temporal-kafka-40-final.lbug \
  --pack temporal \
  --output /tmp/temporal-rules.json
```

The Temporal pack combines independent evidence:

- enriched `io.temporal.*` JVM classes establish dependency presence;
- annotation hovers confirm workflow/activity contracts and method roles;
- convention matches are retained separately at lower confidence;
- `IMPLEMENTATION_OF` maps contracts and methods to concrete classes;
- `LspCallSite` plus `RESOLVES_TO` preserves each invocation range;
- resolved Temporal SDK calls identify stub creation, starts, worker
  registration, signals, queries, and other runtime operations.

Use `--include-raw` when the report must include every row returned by every
rule. Without it, the report contains assembled workflows and a rule-count
audit trail.

## Adding a pack

Create `packs/<name>/pack.json`, place each query in `queries/*.cypher`, and
provide an `assemble(results)` function when raw grouped findings are not
enough. The manifest declares required LadybugDB tables, so incompatible graphs
fail before any rule runs.
