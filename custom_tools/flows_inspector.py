#!/usr/bin/env python3
"""
Custom Business Flows, Entry Points & Exit Points Inspector (Python).

Reads directly from the `.gitnexus/` graph database and extracts:
- Entry Points (REST Controllers, API Handlers, CLI Handlers, Main entry points)
- Exit Points / Terminal Sinks (Database Repositories, Kafka Producers, External Calls)
- Full Step-by-Step Execution Traces
"""

import sys
import os
import json
from pathlib import Path

def inspect_flows(project_path: str):
    abs_project = Path(project_path).resolve()
    db_file = abs_project / ".gitnexus" / "graph.json"
    
    if not db_file.exists():
        print(f"❌ Error: Knowledge graph database not found at '{db_file}'")
        print(f"   Run 'npm run analyze -- {project_path}' first.")
        sys.exit(1)
        
    with open(db_file, "r", encoding="utf-8") as f:
        data = json.load(f)
        
    nodes = {n["id"]: n for n in data.get("nodes", [])}
    relationships = data.get("relationships", [])
    
    # Extract Process nodes
    process_nodes = [n for n in nodes.values() if n.get("label") == "Process"]
    
    # Build relationship mappings
    entry_rels = {}
    step_rels = {}
    for rel in relationships:
        if rel.get("type") == "ENTRY_POINT_OF":
            entry_rels[rel["targetId"]] = rel["sourceId"]
        elif rel.get("type") == "STEP_IN":
            step_rels.setdefault(rel["targetId"], []).append(rel["sourceId"])
            
    print("\n" + "=" * 72)
    print("📍 CUSTOM BUSINESS FLOWS, ENTRY POINTS & EXIT POINTS INSPECTOR (Python)")
    print(f"   Database: {db_file}")
    print(f"   Indexed At: {data.get('indexedAt', 'N/A')} | Mode: {'LSP-Enriched' if data.get('lspEnriched') else 'AST-Only'}")
    print("=" * 72 + "\n")
    
    if not process_nodes:
        print("No multi-step business processes detected in this codebase.")
        return

    print(f"Detected {len(process_nodes)} end-to-end execution flows:\n")
    
    for idx, proc in enumerate(process_nodes, 1):
        props = proc.get("properties", {})
        proc_id = proc["id"]
        label = props.get("label", proc_id)
        entry_id = props.get("entryPointId") or entry_rels.get(proc_id, "(unknown)")
        terminal_id = props.get("terminalId", "(unknown)")
        step_count = props.get("stepCount", len(props.get("trace", [])))
        process_type = props.get("processType", "Execution Process")
        
        entry_node = nodes.get(entry_id)
        terminal_node = nodes.get(terminal_id)
        
        entry_name = entry_node["properties"].get("name") if entry_node else entry_id.split(":")[-1]
        entry_file = entry_node["properties"].get("filePath", "") if entry_node else ""
        entry_line = entry_node["properties"].get("startLine", 1) if entry_node else 1
        
        terminal_name = terminal_node["properties"].get("name") if terminal_node else terminal_id.split(":")[-1]
        terminal_file = terminal_node["properties"].get("filePath", "") if terminal_node else ""
        terminal_line = terminal_node["properties"].get("startLine", 1) if terminal_node else 1
        
        print("━" * 72)
        print(f"⚡ Flow #{idx}: \033[1;36m{label}\033[0m")
        print(f"   Type: {process_type} | Steps: {step_count}")
        print(f"\n   🏁 \033[32mENTRY POINT:\033[0m {entry_name}")
        if entry_file:
            print(f"      File: {entry_file}:{entry_line}")
            
        print(f"\n   🛑 \033[31mEXIT POINT / TERMINAL SINK:\033[0m {terminal_name}")
        if terminal_file:
            print(f"      File: {terminal_file}:{terminal_line}")
            
        trace = props.get("trace")
        if trace and isinstance(trace, list):
            print(f"\n   📋 \033[33mFull Execution Trace:\033[0m")
            for s_idx, step_id in enumerate(trace, 1):
                s_node = nodes.get(step_id)
                s_name = s_node["properties"].get("name") if s_node else step_id.split(":")[-1]
                s_file = s_node["properties"].get("filePath", "") if s_node else ""
                
                is_first = (s_idx == 1)
                is_last = (s_idx == len(trace))
                icon = "🏁 (Entry)" if is_first else ("🛑 (Exit) " if is_last else "├── (Step) ")
                
                print(f"      {s_idx}. \033[90m{icon}\033[0m {s_name} \033[90m({s_file})\033[0m")
        print("\n")
        
    print("=" * 72 + "\n")

if __name__ == "__main__":
    target = sys.argv[1] if len(sys.argv) > 1 else "sample_projects/spring-boot-demo"
    inspect_flows(target)
