#!/usr/bin/env python3
"""
Custom Knowledge Graph Query & Cypher CLI (Python + LadybugDB).

Connects directly to a LadybugDB database:
- Executes custom OpenCypher queries
- Shows node table counts & relation statistics
- Traces callers / callees for any method or class
"""

import sys
import ladybug
from tabulate import tabulate

try:
    from .database import open_read_only_lbug_database, resolve_lbug_path, table_catalog
except ImportError:
    from database import open_read_only_lbug_database, resolve_lbug_path, table_catalog

def query_lbug(project_path: str, mode: str = "summary", arg: str = None):
    db_path = resolve_lbug_path(project_path)
    db = open_read_only_lbug_database(db_path)
    conn = ladybug.Connection(db)
    tables_by_name = table_catalog(conn)
    
    if mode == "summary":
        print("\n" + "=" * 65)
        print("📊 LADYBUGDB KNOWLEDGE GRAPH SUMMARY (Python + Cypher)")
        print(f"   Database: {db_path}")
        print("=" * 65)
        
        # Query node table counts
        node_tables = [name for name, kind in tables_by_name.items() if kind == "NODE" and name != "CodeEmbedding"]
        
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
        
        rel_counts = []
        total_rels = 0
        relation_specs = [
            ("LspRelation", "kind"), ("JvmRelation", "kind"), ("CodeRelation", "type"),
        ]
        for relation_table, property_name in relation_specs:
            if relation_table not in tables_by_name:
                continue
            rel_res = conn.execute(
                f"MATCH ()-[r:{relation_table}]->() RETURN r.{property_name}, count(r) "
                "ORDER BY count(r) DESC;"
            )
            while rel_res.has_next():
                row = rel_res.get_next()
                rel_counts.append((relation_table, row[0], row[1]))
                total_rels += row[1]

        print("🔗 Relationship Breakdown:")
        print(tabulate(rel_counts, headers=["Table", "Kind", "Count"], tablefmt="github"))
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
        print(f"\n📞 Querying call hierarchy for '{arg}' in LadybugDB:\n")
        if "LspRelation" in tables_by_name:
            query = """
                MATCH (src)-[h:LspRelation]->(site:LspCallSite)
                WHERE h.kind = 'HAS_CALLSITE' AND src.name CONTAINS $name
                OPTIONAL MATCH (site)-[r:LspRelation]->(tgt)
                WHERE r.kind = 'RESOLVES_TO'
                RETURN src.name, site.startLine, site.startCharacter,
                       coalesce(tgt.name, site.calleeName), site.status, r.mappingConfidence;
            """
            res = conn.execute(query, parameters={"name": arg})
            headers = ["Caller", "Line", "Character", "Callee", "Status", "Confidence"]
        else:
            query = """
                MATCH (src)-[r:CodeRelation]->(tgt)
                WHERE r.type = 'CALLS' AND src.name CONTAINS $name
                RETURN src.name, tgt.name, r.confidence, r.reason;
            """
            res = conn.execute(query, parameters={"name": arg})
            headers = ["Caller", "Callee", "Confidence", "Reason"]
        rows = []
        while res.has_next():
            rows.append(res.get_next())
        if rows:
            print(tabulate(rows, headers=headers, tablefmt="github"))
        else:
            print(f"No outgoing calls found for '{arg}'.")
        print("")

    closer = getattr(conn, "close", None)
    if callable(closer):
        closer()
    closer = getattr(db, "close", None)
    if callable(closer):
        closer()

if __name__ == "__main__":
    proj = sys.argv[1] if len(sys.argv) > 1 else "sample_projects/spring-boot-demo"
    cmd = sys.argv[2] if len(sys.argv) > 2 else "summary"
    extra = sys.argv[3] if len(sys.argv) > 3 else None
    query_lbug(proj, cmd, extra)
