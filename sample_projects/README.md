# Sample projects

This directory is the single home for runnable fixtures and larger repository
samples used to exercise LSP crawling, build import, LadybugDB persistence, and
semantic extraction.

## Focused polyglot fixtures

| Directory | Language and framework | Representative behavior |
| :--- | :--- | :--- |
| [`spring-boot-demo/`](spring-boot-demo/) | Java, Spring Boot, Temporal | REST, Kafka, JPA, Temporal workflows and activities |
| [`02_python_fastapi_quant/`](02_python_fastapi_quant/) | Python, FastAPI | HTTP and Kafka ingress, SQL and HTTP egress |
| [`03_typescript_express_gateway/`](03_typescript_express_gateway/) | TypeScript, Express | HTTP routing, Prisma and Axios egress |

The Java banking example was byte-for-byte duplicated by `spring-boot-demo`, so
only the canonical fixture is retained.

## Larger Java repositories

- [`bazel-layered-java-monorepo-5000/`](bazel-layered-java-monorepo-5000/):
  deterministic generator for a single-root, three-layer Bazel Java monorepo
  containing exactly 5,000 Java documents across 500 component packages.
- [`bazel-springboot-temporal-monorepo/`](bazel-springboot-temporal-monorepo/):
  multi-root Bazel Spring Boot, Temporal, Kafka, MongoDB, and GKE fixture.
- [`spring-petclinic/`](spring-petclinic/): mixed Maven and Gradle Spring sample.
- [`samples-java/`](samples-java/): Gradle multi-project Java samples.
- [`gs-rest-service/`](gs-rest-service/): Maven/Gradle Spring guide sample.
- [`temporal-pause-resume-compensate/`](temporal-pause-resume-compensate/):
  focused Temporal workflow sample.

## Index a fixture

```bash
npm run index -- build sample_projects/spring-boot-demo \
  --output /tmp/spring-boot-demo.lbug

npm run index -- build sample_projects/02_python_fastapi_quant \
  --output /tmp/python-fastapi-quant.lbug

npm run index -- build sample_projects/03_typescript_express_gateway \
  --output /tmp/typescript-express-gateway.lbug
```
