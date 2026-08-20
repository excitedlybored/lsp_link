#!/usr/bin/env python3
"""
Custom Knowledge Graph Query & Cypher CLI (Python + LadybugDB).

Connects directly to the LadybugDB (.gitnexus/lbug) database:
- Executes custom OpenCypher queries
- Shows node table counts & relation statistics
- Traces callers / callees for any method or class
"""

import sys
from pathlib import Path
import ladybug
from tabulate import tabulate

def query_lbug(project_path: str, mode: str = "summary", arg: str = None):
    abs_project = Path(project_path).resolve()
    db_path = abs_project / ".gitnexus" / "lbug"
    
    if not db_path.exists():
        print(f"❌ Error: LadybugDB database not found at '{db_path}'")
        sys.exit(1)
        
    db = ladybug.Database(str(db_path), read_only=True)
    conn = ladybug.Connection(db)
    
    if mode == "summary":
        print("\n" + "=" * 65)
        print("📊 LADYBUGDB KNOWLEDGE GRAPH SUMMARY (Python + Cypher)")
        print(f"   Database: {db_path}")
        print("=" * 65)
        
        # Query node table counts
        table_result = conn.execute("CALL show_tables() RETURN name, type;")
        tables = []
        while table_result.has_next():
            row = table_result.get_next()
            tables.append((row[0], row[1]))
            
        node_tables = [t[0] for t in tables if t[1] == "NODE" and t[0] != "CodeEmbedding"]
        
        node_counts = []
        total_nodes = 0
        for nt in sorted(node_tables):
            try:
                cnt_res = conn.execute(f"MATCH (n:{nt}) RETURN count(n);")
                if cnt_res.has_next():
                    cnt = cnt_res.get_next()[0]
                    if cnt > 0:
                        node_counts.append((nt, cnt))
                        total_nodes += cnt
            except Exception:
                pass
                
        print("\n🏷️  Node Counts in LadybugDB:")
        print(tabulate(node_counts, headers=["Table", "Row Count"], tablefmt="github"))
        print(f"Total Nodes: {total_nodes}\n")
        
        # Query relationship breakdown
        rel_res = conn.execute("MATCH ()-[r:CodeRelation]->() RETURN r.type, count(r) ORDER BY count(r) DESC;")
        rel_counts = []
        total_rels = 0
        while rel_res.has_next():
            row = rel_res.get_next()
            rel_counts.append((row[0], row[1]))
            total_rels += row[1]
            
        print("🔗 Relationship Breakdown (CodeRelation):")
        print(tabulate(rel_counts, headers=["Relation Type", "Count"], tablefmt="github"))
        print(f"Total Edges: {total_rels}")
        print("\n" + "=" * 65 + "\n")
        
    elif mode == "cypher" and arg:
        print(f"\n🔍 Executing Cypher on LadybugDB:\n   {arg}\n")
        res = conn.execute(arg)
        rows = []
        while res.has_next():
            rows.append(res.get_next())
        if rows:
            print(tabulate(rows, tablefmt="github"))
        else:
            print("(0 rows returned)")
        print("")
        
    elif mode == "calls" and arg:
        print(f"\n📞 Querying CALLS hierarchy for '{arg}' in LadybugDB:\n")
        query = f"""
            MATCH (src)-[r:CodeRelation]->(tgt)
            WHERE r.type = 'CALLS' AND src.name CONTAINS '{arg}'
            RETURN src.name, tgt.name, r.confidence, r.reason;
        """
        res = conn.execute(query)
        rows = []
        while res.has_next():
            row = res.get_next()
            conf_label = "⚡ LSP (1.0)" if row[2] >= 1.0 else "AST (0.6)"
            rows.append((row[0], row[1], conf_label, row[3]))
        if rows:
            print(tabulate(rows, headers=["Caller", "Callee", "Confidence", "Reason"], tablefmt="github"))
        else:
            print(f"No outgoing calls found for '{arg}'.")
        print("")

if __name__ == "__main__":
    proj = sys.argv[1] if len(sys.argv) > 1 else "sample_projects/spring-boot-demo"
    cmd = sys.argv[2] if len(sys.argv) > 2 else "summary"
    extra = sys.argv[3] if len(sys.argv) > 3 else None
    query_lbug(proj, cmd, extra)
