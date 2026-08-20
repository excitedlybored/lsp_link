#!/usr/bin/env python3
"""
Package-Driven Ingress & Egress Boundary Analyzer (Python + LadybugDB).

Detects service boundaries by inspecting third-party SDK packages and imports:
- 🚪 INGRESS PACKAGES:
    • Web / REST Frameworks (Spring Web, JAX-RS, FastAPI, Express, ASP.NET Core)
    • Message Queue Listeners (Spring Kafka, RabbitListener, SQS, JMS)
    • Orchestration / Workflow Entry (Temporal @WorkflowMethod, Signals, Queries)
    • gRPC / RPC Servers (io.grpc, grpcio)
- 🚪 EGRESS PACKAGES:
    • Persistence / Repositories (Spring Data, JPA, MyBatis, Hibernate, SQLAlchemy, TypeORM)
    • Outbound HTTP Clients (RestTemplate, WebClient, OpenFeign, OkHttp, Requests, Axios)
    • Message Queue Producers (KafkaTemplate, RabbitTemplate, JmsTemplate)
    • Task Workers & Activities (Temporal @ActivityMethod, Celery tasks)
- 🔄 END-TO-END BOUNDARY MAPPINGS:
    • Maps Ingress (Source Package) ──► Core Service ──► Egress (Target Package).
"""

import sys
import os
import re
from pathlib import Path
import ladybug
from tabulate import tabulate

# Enterprise Ingress Package Signatures (Java, Python, TS, C#)
INGRESS_PACKAGE_SIGNATURES = [
    # HTTP / REST Ingress
    (r"\borg\.springframework\.web\.bind\.annotation", "HTTP / REST API", "Spring Web REST Controller"),
    (r"\borg\.springframework\.stereotype\.Controller\b", "HTTP / REST API", "Spring MVC Controller"),
    (r"\bjakarta\.ws\.rs\b", "HTTP / REST API", "Jakarta JAX-RS Web Endpoint"),
    (r"\bjavax\.ws\.rs\b", "HTTP / REST API", "Java EE JAX-RS Web Endpoint"),
    (r"\bfastapi\b", "HTTP / REST API", "FastAPI Route Handler"),
    (r"\bflask\b", "HTTP / REST API", "Flask Web Handler"),
    (r"\bexpress\b", "HTTP / REST API", "Express Route Handler"),
    (r"\bMicrosoft\.AspNetCore\.Mvc\b", "HTTP / REST API", "ASP.NET Core Web API"),
    
    # Message Queue Consumer Ingress
    (r"\borg\.springframework\.kafka\.annotation\.KafkaListener\b", "Message Queue Consumer", "Kafka Topic Listener"),
    (r"\borg\.springframework\.amqp\.rabbit\.annotation\b", "Message Queue Consumer", "RabbitMQ Queue Listener"),
    (r"\borg\.springframework\.jms\.annotation\b", "Message Queue Consumer", "JMS Queue Listener"),
    (r"\bcom\.rabbitmq\.client\.Consumer\b", "Message Queue Consumer", "RabbitMQ Consumer"),
    (r"\baiokafka\b", "Message Queue Consumer", "Async Kafka Consumer"),
    
    # Temporal & Workflow Ingress
    (r"\bio\.temporal\.workflow\.WorkflowMethod\b", "Temporal Workflow Trigger", "Temporal Workflow Entry Point"),
    (r"\bio\.temporal\.workflow\.SignalMethod\b", "Temporal Signal Ingress", "Temporal Async Signal Handler"),
    (r"\bio\.temporal\.workflow\.QueryMethod\b", "Temporal Query Ingress", "Temporal State Query Handler"),
    (r"\bio\.temporal\.workflow\.WorkflowInterface\b", "Temporal Workflow Contract", "Temporal Orchestration Contract"),
    
    # gRPC Ingress
    (r"\bio\.grpc\.stub\.StreamObserver\b", "gRPC Service Ingress", "gRPC Server Handler"),
]

# Enterprise Egress Package Signatures (Java, Python, TS, C#)
EGRESS_PACKAGE_SIGNATURES = [
    # Database Persistence Egress
    (r"\borg\.springframework\.data\.repository\b", "Database / Persistence", "Spring Data Repository"),
    (r"\borg\.springframework\.data\.jpa\.repository\b", "Database / JPA Repository", "Spring Data JPA Repository"),
    (r"\bjakarta\.persistence\b", "Database / JPA Persistence", "JPA Entity Persistence"),
    (r"\bjavax\.persistence\b", "Database / JPA Persistence", "JPA Entity Persistence"),
    (r"\borg\.apache\.ibatis\b", "Database / SQL Mapper", "MyBatis SQL Mapper"),
    (r"\borg\.springframework\.jdbc\.core\b", "Database / JDBC Driver", "Spring JdbcTemplate"),
    (r"\bcom\.mongodb\.client\b", "Database / NoSQL Driver", "MongoDB Client Driver"),
    (r"\bsqlalchemy\b", "Database / ORM", "SQLAlchemy ORM Client"),
    (r"\btypeorm\b", "Database / ORM", "TypeORM Client"),
    (r"\bprisma\b", "Database / ORM", "Prisma Database Client"),
    
    # Outbound HTTP / RPC Clients
    (r"\borg\.springframework\.web\.client\.RestTemplate\b", "Outbound HTTP Client", "Spring RestTemplate"),
    (r"\borg\.springframework\.web\.reactive\.function\.client\.WebClient\b", "Outbound HTTP Client", "Spring WebClient (Reactive)"),
    (r"\borg\.springframework\.cloud\.openfeign\b", "Outbound RPC Client", "Spring OpenFeign Client"),
    (r"\bokhttp3\b", "Outbound HTTP Client", "OkHttp3 Client"),
    (r"\borg\.apache\.http\.client\b", "Outbound HTTP Client", "Apache HttpClient"),
    (r"\brequests\b", "Outbound HTTP Client", "Python Requests HTTP Client"),
    (r"\bhttpx\b", "Outbound HTTP Client", "Python HTTPX Client"),
    (r"\baxios\b", "Outbound HTTP Client", "Axios HTTP Client"),
    
    # Message Queue Producers
    (r"\borg\.springframework\.kafka\.core\.KafkaTemplate\b", "Message Queue Producer", "Kafka Event Producer"),
    (r"\borg\.springframework\.amqp\.rabbit\.core\.RabbitTemplate\b", "Message Queue Producer", "RabbitMQ Event Publisher"),
    (r"\borg\.springframework\.jms\.core\.JmsTemplate\b", "Message Queue Producer", "JMS Message Producer"),
    
    # Temporal Activities & Remote Tasks
    (r"\bio\.temporal\.activity\.ActivityMethod\b", "Temporal Activity Worker", "Temporal Distributed Activity Sink"),
    (r"\bio\.temporal\.activity\.ActivityInterface\b", "Temporal Activity Contract", "Temporal Distributed Activity Contract"),
    (r"\bio\.temporal\.activity\b", "Temporal Activity Task", "Temporal Activity Worker"),
]

def scan_file_imports(file_path: Path) -> list:
    """Scans all import statements in a file."""
    imports = []
    try:
        content = file_path.read_text(encoding="utf-8", errors="ignore")
        for line in content.splitlines():
            line = line.strip()
            # Java, TypeScript, C#
            if line.startswith("import ") or line.startswith("using "):
                clean = re.sub(r"^(import static |import |using )", "", line).rstrip(";")
                imports.append(clean)
            # Python
            elif line.startswith("from ") or line.startswith("import "):
                imports.append(line)
    except Exception:
        pass
    return imports

def analyze_packages(project_path: str):
    abs_project = Path(project_path).resolve()
    db_path = abs_project / ".gitnexus" / "lbug"
    
    if not db_path.exists():
        print(f"❌ Error: LadybugDB database not found at '{db_path}'")
        print(f"   Run 'npm run analyze -- {project_path}' first.")
        sys.exit(1)
        
    db = ladybug.Database(str(db_path), read_only=True)
    conn = ladybug.Connection(db)
    
    print("\n" + "=" * 78)
    print("📦 PACKAGE-DRIVEN INGRESS & EGRESS BOUNDARY ANALYZER")
    print(f"   Target: {abs_project}")
    print(f"   Database: {db_path}")
    print("=" * 78)
    
    # 1. Scan all source files in the project for package imports
    file_imports_map = {}
    for p in abs_project.rglob("*"):
        if p.is_file() and p.suffix in [".java", ".py", ".ts", ".tsx", ".cs", ".cpp", ".go"]:
            rel = str(p.relative_to(abs_project))
            if not rel.startswith(".") and "node_modules" not in rel and "target" not in rel:
                imps = scan_file_imports(p)
                if imps:
                    file_imports_map[rel] = imps
                    
    # 2. Identify Ingress & Egress Files via Package Imports
    ingress_findings = []
    egress_findings = []
    
    for rel_file, imps in file_imports_map.items():
        # Check Ingress Signatures
        for imp in imps:
            for pattern, cat, desc in INGRESS_PACKAGE_SIGNATURES:
                if re.search(pattern, imp):
                    ingress_findings.append({
                        "category": cat,
                        "package": imp,
                        "description": desc,
                        "file": rel_file,
                    })
                    break
                    
        # Check Egress Signatures
        for imp in imps:
            for pattern, cat, desc in EGRESS_PACKAGE_SIGNATURES:
                if re.search(pattern, imp):
                    egress_findings.append({
                        "category": cat,
                        "package": imp,
                        "description": desc,
                        "file": rel_file,
                    })
                    break

    # 3. Cross-reference with LadybugDB Routes
    route_res = conn.execute("MATCH (r:Route) RETURN r.name, r.method, r.filePath;")
    while route_res.has_next():
        row = route_res.get_next()
        ingress_findings.append({
            "category": "HTTP / REST Route",
            "package": f"{row[1]} {row[0]}",
            "description": "Exposed REST API Route",
            "file": row[2],
        })

    # Deduplicate findings
    dedup_ingress = {(f["category"], f["package"], f["file"]): f for f in ingress_findings}.values()
    dedup_egress = {(f["category"], f["package"], f["file"]): f for f in egress_findings}.values()

    # Print Ingress
    print("\n🚪 1. INGRESS BOUNDARIES (Identified by Inbound Packages & Routing SDKs):")
    ingress_table = [[f["category"], f["package"], f["file"], f["description"]] for f in dedup_ingress]
    print(tabulate(ingress_table, headers=["Boundary Type", "Package / Route Signature", "Source File", "Description"], tablefmt="github"))
    print(f"Total Detected Ingress Boundaries: {len(dedup_ingress)}\n")

    # Print Egress
    print("🚪 2. EGRESS BOUNDARIES (Identified by Persistence, Client & Producer SDKs):")
    egress_table = [[f["category"], f["package"], f["file"], f["description"]] for f in dedup_egress]
    print(tabulate(egress_table, headers=["Boundary Type", "Package / Target Signature", "Source File", "Description"], tablefmt="github"))
    print(f"Total Detected Egress Boundaries: {len(dedup_egress)}\n")

    # 4. End-to-End Tracing via LadybugDB Processes
    proc_res = conn.execute("MATCH (p:Process) RETURN p.id, p.label, p.entryPointId, p.terminalId, p.stepCount;")
    flows = []
    while proc_res.has_next():
        flows.append(proc_res.get_next())
        
    if flows:
        print("🔄 3. END-TO-END INGRESS ──► EGRESS EXECUTION PATHS (LadybugDB):")
        for idx, fl in enumerate(flows, 1):
            entry_name = fl[2].split(":")[-1]
            exit_name = fl[3].split(":")[-1]
            print(f"   [{idx}] \033[32m[INGRESS: {entry_name}]\033[0m ──({fl[4]} hops)──► \033[31m[EGRESS: {exit_name}]\033[0m")
            print(f"       Process Flow: {fl[1]} (ID: {fl[0]})")
    print("\n" + "=" * 78 + "\n")

if __name__ == "__main__":
    target = sys.argv[1] if len(sys.argv) > 1 else "sample_projects/spring-boot-demo"
    analyze_packages(target)
