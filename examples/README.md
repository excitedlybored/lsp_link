# Multi-Language Test Examples & Benchmarks

This directory contains standalone, runnable examples demonstrating **Polyglot Knowledge Graph Ingestion, AST Analysis, and Ingress/Egress Boundary Detection** across Java, Python, and TypeScript.

---

## 📁 Available Test Examples

| Directory | Language / Framework | Ingress Endpoints | Egress Sinks |
| :--- | :--- | :--- | :--- |
| **[`01_spring_boot_banking/`](file:///Users/zijie-machine/code_ai/ide_link/examples/01_spring_boot_banking)** | **Java** (Spring Boot 3 + Temporal) | REST (`@PostMapping`, `@GetMapping`), Kafka (`@KafkaListener`), Temporal (`@WorkflowMethod`) | JPA (`JpaRepository`), RestTemplate (SWIFT), Kafka Producer, Temporal Activities |
| **[`02_python_fastapi_quant/`](file:///Users/zijie-machine/code_ai/ide_link/examples/02_python_fastapi_quant)** | **Python** (FastAPI + Async Kafka) | FastAPI (`@app.post`, `@app.get`), Async Kafka (`aiokafka`) | SQLAlchemy ORM (`trades.db`), Requests (Clearing House) |
| **[`03_typescript_express_gateway/`](file:///Users/zijie-machine/code_ai/ide_link/examples/03_typescript_express_gateway)** | **TypeScript** (Express + Prisma) | Express Router (`router.post`, `router.get`) | Prisma ORM (`@prisma/client`), Axios (`SWIFT API`) |

---

## 🚀 Quick Test Commands

### 1. Java Spring Boot Enterprise Example
```bash
# Index with live Language Server Protocol (JDT.LS):
npm run analyze -- sample_projects/spring-boot-demo

# Detect Ingress & Egress Boundaries:
npm run boundaries -- sample_projects/spring-boot-demo

# Inspect End-to-End Business Flows:
npm run flows -- sample_projects/spring-boot-demo
```

### 2. Python FastAPI Quant & Risk Example
```bash
# Index Python AST & Call Graph:
npm run analyze -- examples/02_python_fastapi_quant

# Detect Ingress & Egress Boundaries:
npm run boundaries -- examples/02_python_fastapi_quant
```

### 3. TypeScript Express Gateway Example
```bash
# Index TypeScript AST & Call Graph:
npm run analyze -- examples/03_typescript_express_gateway

# Detect Ingress & Egress Boundaries:
npm run boundaries -- examples/03_typescript_express_gateway
```
