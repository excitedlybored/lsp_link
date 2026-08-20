#!/usr/bin/env python3
"""
Custom Graph Benchmark & Comparison Tool (Python).

Reads the persisted `.gitnexus/` graph databases and computes:
- Exact Node & Relationship count differences
- Newly discovered compiler-verified CALLS and IMPLEMENTS edges
- Confidence score distributions
"""

import sys
import json
from pathlib import Path
from tabulate import tabulate

def compare_graphs(project_path: str):
    abs_project = Path(project_path).resolve()
    gitnexus_dir = abs_project / ".gitnexus"
    
    current_db = gitnexus_dir / "graph.json"
    if not current_db.exists():
        print(f"❌ Error: Knowledge graph database not found at '{current_db}'")
        sys.exit(1)
        
    with open(current_db, "r", encoding="utf-8") as f:
        current_data = json.load(f)
        
    nodes = current_data.get("nodes", [])
    relationships = current_data.get("relationships", [])
    
    lsp_edges = [r for r in relationships if r.get("confidence", 0) >= 1.0 and "LSP:" in r.get("reason", "")]
    ast_edges = [r for r in relationships if r.get("confidence", 0) < 1.0 or "LSP:" not in r.get("reason", "")]
    
    print("\n" + "=" * 68)
    print("🔬 KNOWLEDGE GRAPH PRECISION BENCHMARK (Python)")
    print(f"   Project Database: {current_db}")
    print("=" * 68)
    
    summary_table = [
        ["Total Graph Nodes", len(nodes)],
        ["Total Graph Relationships", len(relationships)],
        ["⚡ Compiler-Verified LSP Edges (confidence = 1.0)", len(lsp_edges)],
        ["AST Structural / Heuristic Edges", len(ast_edges)],
        ["Identified Communities / Clusters", current_data.get("stats", {}).get("communities", "N/A")],
        ["Identified Execution Processes", current_data.get("stats", {}).get("processes", "N/A")],
    ]
    
    print(tabulate(summary_table, headers=["Metric", "Value"], tablefmt="github"))
    
    if lsp_edges:
        print("\n⚡ Top Compiler-Verified Discovered Edges (Sample):")
        for r in lsp_edges[:8]:
            src = r["sourceId"].split(":")[-1]
            tgt = r["targetId"].split(":")[-1]
            rtype = r.get("type", "CALLS")
            reason = r.get("reason", "")
            print(f"   • [{rtype}] {src} ──► {tgt} \033[90m({reason})\033[0m")
            
    print("\n" + "=" * 68 + "\n")

if __name__ == "__main__":
    target = sys.argv[1] if len(sys.argv) > 1 else "sample_projects/spring-boot-demo"
    compare_graphs(target)
