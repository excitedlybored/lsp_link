#!/usr/bin/env python3
"""
Custom Graph Benchmark & Comparison Tool (Python + LadybugDB).

Connects directly to the LadybugDB (.gitnexus/lbug) database and computes:
- Exact Node Table & CodeRelation counts
- Breakdown of Compiler-verified LSP Edges (confidence = 1.0) vs AST Heuristic Edges (confidence < 1.0)
- Sample LSP-discovered edges and reasons
"""

import sys
from pathlib import Path
import ladybug
from tabulate import tabulate

def compare_lbug(project_path: str):
    abs_project = Path(project_path).resolve()
    db_path = abs_project / ".gitnexus" / "lbug"
    
    if not db_path.exists():
        print(f"❌ Error: LadybugDB database not found at '{db_path}'")
        sys.exit(1)
        
    db = ladybug.Database(str(db_path), read_only=True)
    conn = ladybug.Connection(db)
    
    print("\n" + "=" * 70)
    print("🔬 LADYBUGDB KNOWLEDGE GRAPH PRECISION BENCHMARK (Python + Cypher)")
    print(f"   Database: {db_path}")
    print("=" * 70)
    
    # 1. Total Edges & Confidence Distribution
    res = conn.execute("""
        MATCH ()-[r:CodeRelation]->()
        RETURN 
            count(r) AS total,
            sum(CASE WHEN r.confidence >= 1.0 AND r.reason CONTAINS 'LSP:' THEN 1 ELSE 0 END) AS lsp_count,
            sum(CASE WHEN r.confidence < 1.0 OR NOT r.reason CONTAINS 'LSP:' THEN 1 ELSE 0 END) AS ast_count;
    """)
    
    total_edges, lsp_edges, ast_edges = 0, 0, 0
    if res.has_next():
        row = res.get_next()
        total_edges, lsp_edges, ast_edges = row[0], row[1], row[2]
        
    # 2. Total Nodes Count
    table_result = conn.execute("CALL show_tables() RETURN name, type;")
    tables = []
    while table_result.has_next():
        row = table_result.get_next()
        if row[1] == "NODE" and row[0] != "CodeEmbedding":
            tables.append(row[0])
            
    total_nodes = 0
    for nt in tables:
        try:
            cnt_res = conn.execute(f"MATCH (n:{nt}) RETURN count(n);")
            if cnt_res.has_next():
                total_nodes += cnt_res.get_next()[0]
        except Exception:
            pass
            
    summary_table = [
        ["Total Graph Nodes", total_nodes],
        ["Total Graph Relationships (CodeRelation)", total_edges],
        ["⚡ Compiler-Verified LSP Edges (confidence = 1.0)", lsp_edges],
        ["AST Structural & Heuristic Edges", ast_edges],
    ]
    print("\n" + tabulate(summary_table, headers=["Metric", "Value"], tablefmt="github"))
    
    # 3. Sample LSP edges
    lsp_sample = conn.execute("""
        MATCH (src)-[r:CodeRelation]->(tgt)
        WHERE r.confidence >= 1.0 AND r.reason CONTAINS 'LSP:'
        RETURN src.name, r.type, tgt.name, r.reason
        LIMIT 8;
    """)
    
    sample_rows = []
    while lsp_sample.has_next():
        r = lsp_sample.get_next()
        sample_rows.append((r[0] or "(node)", r[1], r[2] or "(node)", r[3]))
        
    if sample_rows:
        print("\n⚡ Top Compiler-Verified Discovered Edges (Sample):")
        for src, rtype, tgt, reason in sample_rows:
            print(f"   • [{rtype}] {src} ──► {tgt} \033[90m({reason})\033[0m")
            
    print("\n" + "=" * 70 + "\n")

if __name__ == "__main__":
    target = sys.argv[1] if len(sys.argv) > 1 else "sample_projects/spring-boot-demo"
    compare_lbug(target)
