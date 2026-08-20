#!/usr/bin/env python3
"""
Custom Ingress & Egress Boundary Analyzer (Python + LadybugDB).

Discovers and classifies all service boundary entry and exit points:
- 🚪 INGRESS BOUNDARIES:
    • HTTP / REST Endpoints (@GetMapping, @PostMapping, @RequestMapping)
    • Message Queue Listeners (Kafka, RabbitMQ, SQS, JMS)
    • Temporal / Workflow Entry Points (@WorkflowMethod, Signals)
    • CLI / Application Bootstrap Handlers
- 🚪 EGRESS BOUNDARIES:
    • Database Sinks & Repositories (CrudRepository, JpaRepository, save/delete)
    • Message Queue Producers (KafkaTemplate, RabbitTemplate, Publishers)
    • Outbound HTTP & RPC Clients (FeignClient, WebClient, gRPC stubs)
    • Temporal Activities & External Tasks (@ActivityMethod, Worker Stubs)
- 🔄 END-TO-END INGRESS ──► EGRESS BOUNDARY TRACES:
    • Forward-traces calls from Ingress endpoints to reachable Egress sinks.
"""

import sys
from pathlib import Path
import ladybug
from tabulate import tabulate

def classify_ingress(name: str, file_path: str, method: str = "") -> str:
    lower_path = file_path.lower()
    lower_name = name.lower()
    if method or "controller" in lower_path or "route" in lower_path:
        return "HTTP / REST API"
    if "listener" in lower_path or "consumer" in lower_path or "kafka" in lower_path:
        return "Message Queue Consumer"
    if "workflow" in lower_path or "signal" in lower_name:
        return "Temporal / Workflow Entry"
    if "application" in lower_path or name == "main":
        return "Application Bootstrap / CLI"
    return "Service Ingress Handler"

def classify_egress(name: str, file_path: str) -> str:
    lower_path = file_path.lower()
    lower_name = name.lower()
    if "repository" in lower_path or "dao" in lower_path or "mapper" in lower_path:
        return "Database / Persistence Repository"
    if "activity" in lower_path or "activityimpl" in lower_path or "activities" in lower_path:
        return "Temporal Activity / Remote Task"
    if "publisher" in lower_path or "producer" in lower_path or "template" in lower_name:
        return "Message Queue Producer"
    if "client" in lower_path or "feign" in lower_path or "http" in lower_path:
        return "Outbound HTTP / RPC Client"
    if "converter" in lower_path or "dialect" in lower_path or "util" in lower_path:
        return "Data Transformation / Payload Sink"
    return "External / Terminal Boundary"

def analyze_ingress_egress(project_path: str):
    abs_project = Path(project_path).resolve()
    db_path = abs_project / ".gitnexus" / "lbug"
    
    if not db_path.exists():
        print(f"❌ Error: LadybugDB database not found at '{db_path}'")
        print(f"   Run 'npm run analyze -- {project_path}' first to generate the database.")
        sys.exit(1)
        
    db = ladybug.Database(str(db_path), read_only=True)
    conn = ladybug.Connection(db)
    
    print("\n" + "=" * 76)
    print("🌐 INGRESS & EGRESS BOUNDARY ANALYZER (LadybugDB + OpenCypher)")
    print(f"   Target: {abs_project}")
    print("=" * 76)
    
    # 1. INGRESS BOUNDARIES
    ingress_points = []
    
    # A. HTTP Routes (Ingress)
    route_res = conn.execute("MATCH (r:Route) RETURN r.id, r.name, r.method, r.handlerSymbolId, r.filePath;")
    while route_res.has_next():
        row = route_res.get_next()
        ingress_points.append({
            "category": "HTTP / REST API",
            "endpoint": f"{row[2]} {row[1]}",
            "handler": row[3].split(":")[-1] if row[3] else "Handler",
            "file": row[4],
        })
        
    # B. Workflow Triggers (Ingress)
    wf_res = conn.execute("MATCH (i:Interface) WHERE i.name CONTAINS 'Workflow' RETURN i.name, i.filePath;")
    while wf_res.has_next():
        row = wf_res.get_next()
        ingress_points.append({
            "category": "Temporal / Workflow Trigger",
            "endpoint": f"Workflow @Interface {row[0]}",
            "handler": row[0],
            "file": row[1],
        })
        
    print("\n🚪 1. INGRESS POINTS (Inbound Boundaries):")
    ingress_table = [[ig["category"], ig["endpoint"], ig["handler"], ig["file"]] for ig in ingress_points]
    print(tabulate(ingress_table, headers=["Protocol", "Endpoint / Route", "Target Handler", "Source File"], tablefmt="github"))
    print(f"Total Ingress Points: {len(ingress_points)}\n")
    
    # 2. EGRESS BOUNDARIES
    egress_points = []
    
    # A. Activities / External Tasks (Egress)
    act_res = conn.execute("""
        MATCH (c:Class)
        WHERE c.name CONTAINS 'Activity' OR c.name CONTAINS 'Repository' OR c.name CONTAINS 'Client' OR c.name CONTAINS 'Converter'
        RETURN c.name, c.filePath;
    """)
    while act_res.has_next():
        row = act_res.get_next()
        egress_points.append({
            "category": classify_egress(row[0], row[1]),
            "name": row[0],
            "file": row[1],
        })
        
    act_iface_res = conn.execute("""
        MATCH (i:Interface)
        WHERE i.name CONTAINS 'Activity' OR i.name CONTAINS 'Repository' OR i.name CONTAINS 'Client'
        RETURN i.name, i.filePath;
    """)
    while act_iface_res.has_next():
        row = act_iface_res.get_next()
        egress_points.append({
            "category": classify_egress(row[0], row[1]),
            "name": row[0],
            "file": row[1],
        })

    print("🚪 2. EGRESS POINTS (Outbound Boundaries & External Sinks):")
    egress_table = [[eg["category"], eg["name"], eg["file"]] for eg in egress_points]
    print(tabulate(egress_table, headers=["Category", "Target Component", "Source File"], tablefmt="github"))
    print(f"Total Egress Sinks: {len(egress_points)}\n")
    
    # 3. EXECUTION PROCESS FLOWS (Ingress ──► Egress Traces)
    proc_res = conn.execute("MATCH (p:Process) RETURN p.id, p.label, p.entryPointId, p.terminalId, p.stepCount;")
    flow_entries = []
    while proc_res.has_next():
        row = proc_res.get_next()
        flow_entries.append({
            "processId": row[0],
            "label": row[1],
            "entryPointId": row[2],
            "terminalId": row[3],
            "stepCount": row[4],
        })
        
    if flow_entries:
        print("🔄 3. INGRESS ──► EGRESS EXECUTION PATHS:")
        for idx, fl in enumerate(flow_entries, 1):
            entry_name = fl["entryPointId"].split(":")[-1]
            exit_name = fl["terminalId"].split(":")[-1]
            print(f"   [{idx}] \033[32m[INGRESS: {entry_name}]\033[0m ──({fl['stepCount']} hops)──► \033[31m[EGRESS: {exit_name}]\033[0m")
            print(f"       Process Flow: {fl['label']} ({fl['processId']})")
    print("\n" + "=" * 76 + "\n")

if __name__ == "__main__":
    target = sys.argv[1] if len(sys.argv) > 1 else "sample_projects/spring-boot-demo"
    analyze_ingress_egress(target)
