#!/usr/bin/env python3
"""
Custom Business Flows, Entry Points & Exit Points Inspector (Python + LadybugDB).

Connects directly to the LadybugDB (.gitnexus/lbug) database and runs OpenCypher queries:
- Extracts Entry Points (REST Controllers, API Handlers, CLI Handlers, Main entry points)
- Extracts Exit Points / Terminal Sinks (Database Repositories, Kafka Producers, External Calls)
- Extracts Step-by-Step Execution Traces via STEP_IN_PROCESS relations
"""

import sys
import os
from pathlib import Path
import ladybug

def inspect_flows(project_path: str):
    abs_project = Path(project_path).resolve()
    db_path = abs_project / ".gitnexus" / "lbug"
    
    if not db_path.exists():
        print(f"❌ Error: LadybugDB database not found at '{db_path}'")
        print(f"   Run 'npm run analyze -- {project_path}' first to generate the database.")
        sys.exit(1)
        
    db = ladybug.Database(str(db_path), read_only=True)
    conn = ladybug.Connection(db)
    
    print("\n" + "=" * 74)
    print("📍 CUSTOM BUSINESS FLOWS, ENTRY POINTS & EXIT POINTS (LadybugDB + Cypher)")
    print(f"   Database: {db_path}")
    print("=" * 74 + "\n")
    
    # 1. Query all Process nodes
    process_query = """
        MATCH (p:Process)
        RETURN p.id, p.label, p.processType, p.stepCount, p.entryPointId, p.terminalId;
    """
    proc_result = conn.execute(process_query)
    processes = []
    while proc_result.has_next():
        row = proc_result.get_next()
        processes.append({
            "id": row[0],
            "label": row[1],
            "processType": row[2],
            "stepCount": row[3],
            "entryPointId": row[4],
            "terminalId": row[5],
        })
        
    if not processes:
        print("No multi-step business processes detected in this codebase.")
        return
        
    print(f"Detected {len(processes)} end-to-end execution flows in LadybugDB:\n")
    
    # 2. Query execution step traces
    for idx, proc in enumerate(processes, 1):
        proc_id = proc["id"]
        
        # Query steps for this process
        steps_query = f"""
            MATCH (n)-[r:CodeRelation]->(p:Process)
            WHERE p.id = '{proc_id}' AND r.type = 'STEP_IN_PROCESS'
            RETURN r.step, n.id, n.name, n.filePath
            ORDER BY r.step;
        """
        step_result = conn.execute(steps_query)
        steps = []
        while step_result.has_next():
            s_row = step_result.get_next()
            steps.append({
                "step": s_row[0],
                "id": s_row[1],
                "name": s_row[2] or s_row[1].split(":")[-1],
                "filePath": s_row[3] or "",
            })
            
        entry_id = proc["entryPointId"]
        entry_name = entry_id.split(":")[-1]
        terminal_id = proc["terminalId"]
        terminal_name = terminal_id.split(":")[-1]
        
        print("━" * 74)
        print(f"⚡ Flow #{idx}: \033[1;36m{proc['label']}\033[0m")
        print(f"   ID: {proc['id']} | Type: {proc['processType']} | Steps: {proc['stepCount']}")
        print(f"\n   🏁 \033[32mENTRY POINT:\033[0m {entry_name}")
        print(f"      Node ID: {entry_id}")
        print(f"\n   🛑 \033[31mEXIT POINT / TERMINAL SINK:\033[0m {terminal_name}")
        print(f"      Node ID: {terminal_id}")
        
        if steps:
            print(f"\n   📋 \033[33mFull Execution Trace ({len(steps)} steps):\033[0m")
            for s_idx, st in enumerate(steps, 1):
                is_first = (s_idx == 1)
                is_last = (s_idx == len(steps))
                icon = "🏁 (Entry)" if is_first else ("🛑 (Exit) " if is_last else "├── (Step) ")
                print(f"      {s_idx}. \033[90m{icon}\033[0m {st['name']} \033[90m({st['filePath']})\033[0m")
        print("\n")
        
    print("=" * 74 + "\n")

if __name__ == "__main__":
    target = sys.argv[1] if len(sys.argv) > 1 else "sample_projects/spring-boot-demo"
    inspect_flows(target)
