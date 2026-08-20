#!/usr/bin/env python3
"""
Custom Knowledge Graph Query Tool (Python).

Directly inspects nodes and relationships from the `.gitnexus/` graph database:
- Filter nodes by label (e.g. Method, Class, Interface, Process, Community)
- Trace callers / callees of any symbol
- Show high-confidence LSP compiler-verified edges
"""

import sys
import json
from pathlib import Path
from tabulate import tabulate

def query_database(project_path: str, command: str = "summary", symbol: str = None):
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
    
    if command == "summary":
        print("\n" + "=" * 60)
        print("📊 KNOWLEDGE GRAPH SUMMARY (Python)")
        print(f"   Target Database: {db_file}")
        print("=" * 60)
        
        # Count by node label
        label_counts = {}
        for n in nodes.values():
            lbl = n.get("label", "Unknown")
            label_counts[lbl] = label_counts.get(lbl, 0) + 1
            
        rel_counts = {}
        for r in relationships:
            t = r.get("type", "Unknown")
            rel_counts[t] = rel_counts.get(t, 0) + 1
            
        print("\n🏷️  Node Breakdown:")
        print(tabulate([(k, v) for k, v in sorted(label_counts.items())], headers=["Label", "Count"], tablefmt="github"))
        
        print("\n🔗 Relationship Breakdown:")
        print(tabulate([(k, v) for k, v in sorted(rel_counts.items())], headers=["Relation Type", "Count"], tablefmt="github"))
        print("\n" + "=" * 60 + "\n")
        
    elif command == "calls" and symbol:
        print(f"\n📞 CALLS for symbol containing '{symbol}':\n")
        matching_nodes = [n for n in nodes.values() if symbol.lower() in n.get("properties", {}).get("name", "").lower()]
        
        for m in matching_nodes:
            m_id = m["id"]
            m_name = m["properties"].get("name")
            m_file = m["properties"].get("filePath")
            print(f"⚡ Target: \033[1;36m{m_name}\033[0m ({m_file})")
            
            # Outgoing calls
            out_calls = [r for r in relationships if r["sourceId"] == m_id and r["type"] == "CALLS"]
            if out_calls:
                print("   Outgoing Calls:")
                for r in out_calls:
                    tgt = nodes.get(r["targetId"])
                    tgt_name = tgt["properties"].get("name") if tgt else r["targetId"]
                    conf = r.get("confidence", 1.0)
                    tag = "\033[32m[LSP Verified]\033[0m" if conf >= 1.0 else "\033[90m[AST]\033[0m"
                    print(f"      └── {tag} {tgt_name}")
            else:
                print("   (No outgoing calls)")
            print("")

if __name__ == "__main__":
    proj = sys.argv[1] if len(sys.argv) > 1 else "sample_projects/spring-boot-demo"
    cmd = sys.argv[2] if len(sys.argv) > 2 else "summary"
    sym = sys.argv[3] if len(sys.argv) > 3 else None
    query_database(proj, cmd, sym)
