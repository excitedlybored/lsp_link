#!/usr/bin/env python3
"""
SDK-Driven Ingress & Egress Boundary Analyzer and Node Linker (Python + LadybugDB).

Features:
1. Boundary Analysis:
   - Reads tracked SDK definitions from `graph_tools/sdk_registry.json`
   - Scans project source files for Ingress & Egress package imports
   - Queries LadybugDB (.gitnexus/lbug) to construct End-to-End Traces
2. GitNexus Node Linking & Path Tracing:
   - Shows how GitNexus nodes (Route -> Method -> Class -> Calls -> Sinks) are linked
   - Trace full call paths from Ingress endpoints to Egress sinks
3. SDK Registry Management:
   - List tracked SDKs: `uv run python graph_tools/ingress_egress_analyzer.py list-sdks`
   - Add/Edit SDK: `uv run python graph_tools/ingress_egress_analyzer.py add-sdk ...`
   - Remove SDK: `uv run python graph_tools/ingress_egress_analyzer.py remove-sdk ...`
"""

import sys
import os
import re
import json
import argparse
from pathlib import Path
import ladybug
from tabulate import tabulate

REGISTRY_PATH = Path(__file__).parent / "sdk_registry.json"

def load_sdk_registry() -> dict:
    """Loads the SDK boundary registry from JSON."""
    if not REGISTRY_PATH.exists():
        print(f"❌ Error: SDK registry not found at '{REGISTRY_PATH}'")
        sys.exit(1)
    with open(REGISTRY_PATH, "r", encoding="utf-8") as f:
        return json.load(f)

def save_sdk_registry(data: dict):
    """Saves the SDK boundary registry to JSON."""
    with open(REGISTRY_PATH, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)

def list_sdks(boundary_filter: str = None, lang_filter: str = None):
    """Lists all tracked Ingress and Egress SDKs."""
    data = load_sdk_registry()
    print("\n" + "=" * 80)
    print("📋 TRACKED SDK BOUNDARY REGISTRY")
    print(f"   Config File: {REGISTRY_PATH}")
    print("=" * 80)

    if not boundary_filter or boundary_filter == "ingress":
        ingress_list = data.get("ingress", [])
        if lang_filter:
            ingress_list = [s for s in ingress_list if s.get("language") == lang_filter]
        print(f"\n🚪 INGRESS SDKs ({len(ingress_list)} tracked):")
        rows = [[s["id"], s.get("language", "all"), s["category"], s["pattern"], s["description"]] for s in ingress_list]
        print(tabulate(rows, headers=["ID", "Lang", "Category", "Regex Pattern", "Description"], tablefmt="github"))

    if not boundary_filter or boundary_filter == "egress":
        egress_list = data.get("egress", [])
        if lang_filter:
            egress_list = [s for s in egress_list if s.get("language") == lang_filter]
        print(f"\n🚪 EGRESS SDKs ({len(egress_list)} tracked):")
        rows = [[s["id"], s.get("language", "all"), s["category"], s["pattern"], s["description"]] for s in egress_list]
        print(tabulate(rows, headers=["ID", "Lang", "Category", "Regex Pattern", "Description"], tablefmt="github"))
    print("\n" + "=" * 80 + "\n")

def add_sdk(boundary: str, sdk_id: str, lang: str, category: str, pattern: str, desc: str):
    """Adds or updates an SDK entry in the registry."""
    data = load_sdk_registry()
    if boundary not in ["ingress", "egress"]:
        print(f"❌ Error: Boundary must be 'ingress' or 'egress', got '{boundary}'")
        sys.exit(1)
        
    entry_list = data.setdefault(boundary, [])
    existing = next((item for item in entry_list if item["id"] == sdk_id), None)
    if existing:
        existing["language"] = lang
        existing["category"] = category
        existing["pattern"] = pattern
        existing["description"] = desc
        print(f"✓ Updated existing SDK signature: '{sdk_id}' in {boundary.upper()}")
    else:
        entry_list.append({
            "id": sdk_id,
            "language": lang,
            "category": category,
            "pattern": pattern,
            "description": desc
        })
        print(f"✓ Added new SDK signature: '{sdk_id}' to {boundary.upper()}")
        
    save_sdk_registry(data)

def remove_sdk(boundary: str, sdk_id: str):
    """Removes an SDK entry from the registry."""
    data = load_sdk_registry()
    if boundary not in ["ingress", "egress"]:
        print(f"❌ Error: Boundary must be 'ingress' or 'egress', got '{boundary}'")
        sys.exit(1)
        
    entry_list = data.get(boundary, [])
    initial_len = len(entry_list)
    data[boundary] = [item for item in entry_list if item["id"] != sdk_id]
    
    if len(data[boundary]) < initial_len:
        save_sdk_registry(data)
        print(f"✓ Successfully removed SDK '{sdk_id}' from {boundary.upper()}")
    else:
        print(f"⚠️  SDK ID '{sdk_id}' not found in {boundary.upper()}")

def scan_file_imports(file_path: Path) -> list:
    """Scans all import / using statements in a source file."""
    imports = []
    try:
        content = file_path.read_text(encoding="utf-8", errors="ignore")
        for line in content.splitlines():
            line = line.strip()
            if line.startswith("import ") or line.startswith("using "):
                clean = re.sub(r"^(import static |import |using )", "", line).rstrip(";")
                imports.append(clean)
            elif line.startswith("from ") or line.startswith("import "):
                imports.append(line)
    except Exception:
        pass
    return imports

def trace_ingress_nodes(project_path: str):
    """Demonstrates how GitNexus graph nodes link Ingress points to downstream callees and sinks."""
    abs_project = Path(project_path).resolve()
    db_path = abs_project / ".gitnexus" / "lbug"
    
    if not db_path.exists():
        print(f"❌ Error: LadybugDB database not found at '{db_path}'")
        sys.exit(1)
        
    db = ladybug.Database(str(db_path), read_only=True)
    conn = ladybug.Connection(db)

    print("\n" + "=" * 80)
    print("🔗 GITNEXUS NODE LINKING (Route ──► Method ──► Outgoing Calls ──► Egress)")
    print(f"   Database: {db_path}")
    print("=" * 80)

    # 1. Ingress Routes linked to Methods and Classes
    ingress_query = """
        MATCH (r:Route)
        MATCH (m:Method) WHERE m.id = r.handlerSymbolId
        MATCH (c:Class)-[hm:CodeRelation]->(m) WHERE hm.type = 'HAS_METHOD'
        RETURN r.method, r.name, m.name, c.name, m.filePath, m.id;
    """
    res = conn.execute(ingress_query)
    routes = []
    while res.has_next():
        routes.append(res.get_next())

    print(f"\n🚪 Ingress Route Nodes ({len(routes)} routes bound to Graph Methods):")
    for r in routes[:6]:
        r_method, r_path, m_name, c_name, f_path, m_id = r
        print(f"   • \033[36m(Route: {r_method} {r_path})\033[0m")
        print(f"       └──[:HANDLES_ROUTE]──► \033[32m(Method: {c_name}.{m_name})\033[0m")
        print(f"       └──[:DEFINED_IN]──► \033[90m(File: {f_path})\033[0m")

        # Query outgoing calls from this ingress handler
        calls_query = f"""
            MATCH (src:Method)-[rel:CodeRelation]->(tgt)
            WHERE src.id = '{m_id}' AND rel.type = 'CALLS'
            RETURN tgt.name, rel.confidence, rel.reason
            LIMIT 4;
        """
        call_res = conn.execute(calls_query)
        while call_res.has_next():
            c_row = call_res.get_next()
            conf_tag = "\033[32m[LSP Verified 1.0]\033[0m" if c_row[1] >= 1.0 else "\033[90m[AST 0.85]\033[0m"
            print(f"            └──[:CALLS]──► {conf_tag} \033[33m{c_row[0]}\033[0m ({c_row[2]})")
        print("")

    print("=" * 80 + "\n")

def analyze_project(project_path: str):
    """Performs boundary analysis on a project using the SDK registry."""
    abs_project = Path(project_path).resolve()
    gitnexus_dir = abs_project / ".gitnexus"
    db_path = gitnexus_dir / "lbug"
    graph_json_path = gitnexus_dir / "graph.json"
    
    if not db_path.exists() and not graph_json_path.exists():
        print(f"❌ Error: GitNexus index not found at '{gitnexus_dir}'")
        print(f"   Run 'npm run analyze -- {project_path}' first.")
        sys.exit(1)
        
    registry = load_sdk_registry()
    ingress_rules = registry.get("ingress", [])
    egress_rules = registry.get("egress", [])
    
    print("\n" + "=" * 80)
    print("📦 SDK-DRIVEN INGRESS & EGRESS BOUNDARY ANALYZER")
    print(f"   Target Repository: {abs_project}")
    print(f"   Storage: {db_path if db_path.exists() else graph_json_path}")
    print(f"   Active SDK Rules: {len(ingress_rules)} Ingress | {len(egress_rules)} Egress")
    print("=" * 80)
    
    # 1. Scan source files for imports
    file_imports_map = {}
    for p in abs_project.rglob("*"):
        if p.is_file() and p.suffix in [".java", ".py", ".ts", ".tsx", ".cs", ".cpp", ".go", ".cbl", ".cob"]:
            rel = str(p.relative_to(abs_project))
            if not rel.startswith(".") and "node_modules" not in rel and "target" not in rel:
                imps = scan_file_imports(p)
                if imps:
                    file_imports_map[rel] = imps
                    
    # 2. Match Ingress & Egress Rules
    ingress_findings = []
    egress_findings = []
    
    for rel_file, imps in file_imports_map.items():
        for imp in imps:
            for rule in ingress_rules:
                if re.search(rule["pattern"], imp):
                    ingress_findings.append({
                        "category": rule["category"],
                        "package": imp,
                        "description": rule["description"],
                        "file": rel_file,
                    })
                    break
            for rule in egress_rules:
                if re.search(rule["pattern"], imp):
                    egress_findings.append({
                        "category": rule["category"],
                        "package": imp,
                        "description": rule["description"],
                        "file": rel_file,
                    })
                    break

    # 3. Incorporate exposed routes and execution flows
    flows = []
    if db_path.exists():
        try:
            db = ladybug.Database(str(db_path), read_only=True)
            conn = ladybug.Connection(db)
            route_res = conn.execute("MATCH (r:Route) RETURN r.name, r.method, r.filePath;")
            while route_res.has_next():
                row = route_res.get_next()
                ingress_findings.append({
                    "category": "HTTP / REST Route",
                    "package": f"{row[1]} {row[0]}",
                    "description": "Exposed REST API Endpoint",
                    "file": row[2],
                })
            proc_res = conn.execute("MATCH (p:Process) RETURN p.id, p.label, p.entryPointId, p.terminalId, p.stepCount;")
            while proc_res.has_next():
                flows.append(proc_res.get_next())
        except Exception:
            pass
    elif graph_json_path.exists():
        with open(graph_json_path, "r", encoding="utf-8") as f:
            graph_data = json.load(f)
        for node in graph_data.get("nodes", []):
            if node.get("label") == "Route":
                props = node.get("properties", {})
                ingress_findings.append({
                    "category": "HTTP / REST Route",
                    "package": f"{props.get('method', 'GET')} {props.get('name', props.get('path', ''))}",
                    "description": "Exposed REST API Endpoint",
                    "file": props.get("filePath", ""),
                })
            elif node.get("label") == "Process":
                props = node.get("properties", {})
                flows.append([
                    node.get("id"),
                    props.get("label", "Process Flow"),
                    props.get("entryPointId", "EntryPoint"),
                    props.get("terminalId", "TerminalSink"),
                    props.get("stepCount", 1)
                ])

    dedup_ingress = {(f["category"], f["package"], f["file"]): f for f in ingress_findings}.values()
    dedup_egress = {(f["category"], f["package"], f["file"]): f for f in egress_findings}.values()

    # Print Ingress
    print("\n🚪 1. INGRESS BOUNDARIES (Tracked via SDK Registry):")
    ingress_table = [[f["category"], f["package"], f["file"], f["description"]] for f in dedup_ingress]
    print(tabulate(ingress_table, headers=["Boundary Type", "Package / Route Signature", "Source File", "Description"], tablefmt="github"))
    print(f"Total Detected Ingress Boundaries: {len(dedup_ingress)}\n")

    # Print Egress
    print("🚪 2. EGRESS BOUNDARIES (Tracked via SDK Registry):")
    egress_table = [[f["category"], f["package"], f["file"], f["description"]] for f in dedup_egress]
    print(tabulate(egress_table, headers=["Boundary Type", "Package / Target Signature", "Source File", "Description"], tablefmt="github"))
    print(f"Total Detected Egress Boundaries: {len(dedup_egress)}\n")

    # 4. End-to-End Tracing
    if flows:
        print("🔄 3. END-TO-END INGRESS ──► EGRESS EXECUTION PATHS (LadybugDB / Knowledge Graph):")
        for idx, fl in enumerate(flows, 1):
            entry_name = str(fl[2]).split(":")[-1]
            exit_name = str(fl[3]).split(":")[-1]
            print(f"   [{idx}] \033[32m[INGRESS: {entry_name}]\033[0m ──({fl[4]} hops)──► \033[31m[EGRESS: {exit_name}]\033[0m")
            print(f"       Process Flow: {fl[1]} (ID: {fl[0]})")
    print("\n" + "=" * 80 + "\n")

def main():
    raw_args = sys.argv[1:]
    
    # If first arg is a project path (not a subcommand or flag)
    if raw_args and not raw_args[0].startswith("-") and raw_args[0] not in ["list-sdks", "links", "add-sdk", "remove-sdk"]:
        target_project = raw_args[0]
        analyze_project(target_project)
        return

    parser = argparse.ArgumentParser(description="SDK-Driven Ingress & Egress Analyzer & SDK Registry CLI")
    subparsers = parser.add_subparsers(dest="command")

    # Subcommand: list-sdks
    list_p = subparsers.add_parser("list-sdks", help="List all tracked Ingress and Egress SDK signatures")
    list_p.add_argument("--boundary", choices=["ingress", "egress"], help="Filter by boundary type")
    list_p.add_argument("--lang", help="Filter by language (e.g. java, python, typescript, csharp)")

    # Subcommand: links
    links_p = subparsers.add_parser("links", help="Display GitNexus graph node links connecting Ingress to Egress")
    links_p.add_argument("project", nargs="?", default="sample_projects/spring-boot-demo", help="Target project path")

    # Subcommand: add-sdk
    add_p = subparsers.add_parser("add-sdk", help="Add or update an SDK signature in the registry")
    add_p.add_argument("--boundary", required=True, choices=["ingress", "egress"], help="Boundary type")
    add_p.add_argument("--id", required=True, help="Unique identifier for the SDK rule")
    add_p.add_argument("--lang", default="all", help="Target language")
    add_p.add_argument("--category", required=True, help="Category")
    add_p.add_argument("--pattern", required=True, help="Regex pattern")
    add_p.add_argument("--desc", default="", help="Description")

    # Subcommand: remove-sdk
    rm_p = subparsers.add_parser("remove-sdk", help="Remove an SDK signature from the registry")
    rm_p.add_argument("--boundary", required=True, choices=["ingress", "egress"], help="Boundary type")
    rm_p.add_argument("--id", required=True, help="Unique ID of the SDK rule to remove")

    args = parser.parse_args()

    if args.command == "list-sdks":
        list_sdks(args.boundary, args.lang)
    elif args.command == "links":
        trace_ingress_nodes(args.project)
    elif args.command == "add-sdk":
        add_sdk(args.boundary, args.id, args.lang, args.category, args.pattern, args.desc)
    elif args.command == "remove-sdk":
        remove_sdk(args.boundary, args.id)
    else:
        analyze_project("sample_projects/spring-boot-demo")

if __name__ == "__main__":
    main()
