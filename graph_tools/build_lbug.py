#!/usr/bin/env python3
"""
LadybugDB (.gitnexus/lbug) and Meta.json Generator.

Reads .gitnexus/graph.json produced by the analyze pipeline and compiles it into:
1. `.gitnexus/lbug/` (Native LadybugDB columnar graph database with OpenCypher schema)
2. `.gitnexus/meta.json` (Full GitNexus metadata manifest)
"""

import sys
import os
import json
import shutil
from pathlib import Path
import ladybug

def escape_cypher_str(val: str) -> str:
    if val is None:
        return ""
    return str(val).replace("\\", "\\\\").replace("'", "\\'").replace('"', '\\"').replace("\n", " ")

def build_lbug_from_graph(target_dir: str):
    target_path = Path(target_dir).resolve()
    gitnexus_dir = target_path / ".gitnexus"
    graph_file = gitnexus_dir / "graph.json"
    db_path = gitnexus_dir / "lbug"
    meta_file = gitnexus_dir / "meta.json"

    if not graph_file.exists():
        print(f"❌ Error: graph.json not found in '{gitnexus_dir}'")
        sys.exit(1)

    with open(graph_file, "r", encoding="utf-8") as f:
        graph_data = json.load(f)

    # Recreate clean .gitnexus/lbug database
    gitnexus_dir.mkdir(parents=True, exist_ok=True)
    if db_path.exists():
        if db_path.is_dir():
            shutil.rmtree(db_path)
        else:
            db_path.unlink()

    db = ladybug.Database(str(db_path))
    conn = ladybug.Connection(db)

    # 1. Create Node Tables
    node_tables = {
        "Class": "CREATE NODE TABLE Class (id STRING, name STRING, filePath STRING, namespace STRING, startLine INT64, endLine INT64, PRIMARY KEY (id));",
        "Interface": "CREATE NODE TABLE Interface (id STRING, name STRING, filePath STRING, namespace STRING, startLine INT64, endLine INT64, PRIMARY KEY (id));",
        "Method": "CREATE NODE TABLE Method (id STRING, name STRING, filePath STRING, signature STRING, startLine INT64, endLine INT64, PRIMARY KEY (id));",
        "Function": "CREATE NODE TABLE Function (id STRING, name STRING, filePath STRING, signature STRING, startLine INT64, endLine INT64, PRIMARY KEY (id));",
        "Route": "CREATE NODE TABLE Route (id STRING, name STRING, method STRING, filePath STRING, handlerSymbolId STRING, startLine INT64, endLine INT64, PRIMARY KEY (id));",
        "Community": "CREATE NODE TABLE Community (id STRING, name STRING, size INT64, PRIMARY KEY (id));",
        "Process": "CREATE NODE TABLE Process (id STRING, label STRING, entryPointId STRING, terminalId STRING, stepCount INT64, PRIMARY KEY (id));",
        "File": "CREATE NODE TABLE File (id STRING, name STRING, path STRING, PRIMARY KEY (id));",
        "Folder": "CREATE NODE TABLE Folder (id STRING, name STRING, path STRING, PRIMARY KEY (id));",
        "CodeElement": "CREATE NODE TABLE CodeElement (id STRING, name STRING, filePath STRING, PRIMARY KEY (id));",
        "Constructor": "CREATE NODE TABLE Constructor (id STRING, name STRING, filePath STRING, PRIMARY KEY (id));",
        "Property": "CREATE NODE TABLE Property (id STRING, name STRING, filePath STRING, PRIMARY KEY (id));",
        "Section": "CREATE NODE TABLE Section (id STRING, name STRING, filePath STRING, PRIMARY KEY (id));",
    }

    for tbl, ddl in node_tables.items():
        try:
            conn.execute(ddl)
        except Exception as e:
            pass

    # 2. Create Unified Relationship Table
    rel_ddl = """
    CREATE REL TABLE CodeRelation (
        FROM Class TO Class,
        FROM Class TO Interface,
        FROM Class TO Method,
        FROM Method TO Method,
        FROM Method TO Class,
        FROM Method TO Process,
        FROM Route TO Method,
        FROM File TO Class,
        FROM File TO Method,
        FROM Folder TO File,
        FROM CodeElement TO CodeElement,
        FROM Community TO Class,
        FROM Community TO Method,
        type STRING,
        confidence DOUBLE,
        reason STRING,
        step INT64
    );
    """
    try:
        conn.execute(rel_ddl)
    except Exception as e:
        pass

    # 3. Populate Nodes
    nodes = graph_data.get("nodes", [])
    valid_node_ids = set()
    node_types = {}

    for node in nodes:
        node_id = node.get("id")
        label = node.get("label", "CodeElement")
        props = node.get("properties", {})
        
        if label not in node_tables:
            label = "CodeElement"

        valid_node_ids.add(node_id)
        node_types[node_id] = label

        esc_id = escape_cypher_str(node_id)
        esc_name = escape_cypher_str(props.get("name", node_id.split(":")[-1]))
        esc_file = escape_cypher_str(props.get("filePath", props.get("path", "")))

        if label == "Route":
            esc_method = escape_cypher_str(props.get("method", "GET"))
            esc_handler = escape_cypher_str(props.get("handlerSymbolId", ""))
            s_line = int(props.get("startLine", 1))
            e_line = int(props.get("endLine", 1))
            query = f"CREATE (n:Route {{id: '{esc_id}', name: '{esc_name}', method: '{esc_method}', filePath: '{esc_file}', handlerSymbolId: '{esc_handler}', startLine: {s_line}, endLine: {e_line}}});"
        elif label == "Process":
            esc_lbl = escape_cypher_str(props.get("label", "Process Flow"))
            esc_ep = escape_cypher_str(props.get("entryPointId", ""))
            esc_term = escape_cypher_str(props.get("terminalId", ""))
            steps = int(props.get("stepCount", 1))
            query = f"CREATE (n:Process {{id: '{esc_id}', label: '{esc_lbl}', entryPointId: '{esc_ep}', terminalId: '{esc_term}', stepCount: {steps}}});"
        elif label in ["Class", "Interface"]:
            esc_ns = escape_cypher_str(props.get("namespace", ""))
            s_line = int(props.get("startLine", 1))
            e_line = int(props.get("endLine", 1))
            query = f"CREATE (n:{label} {{id: '{esc_id}', name: '{esc_name}', filePath: '{esc_file}', namespace: '{esc_ns}', startLine: {s_line}, endLine: {e_line}}});"
        elif label in ["Method", "Function"]:
            esc_sig = escape_cypher_str(props.get("signature", ""))
            s_line = int(props.get("startLine", 1))
            e_line = int(props.get("endLine", 1))
            query = f"CREATE (n:{label} {{id: '{esc_id}', name: '{esc_name}', filePath: '{esc_file}', signature: '{esc_sig}', startLine: {s_line}, endLine: {e_line}}});"
        elif label == "Community":
            size = int(props.get("size", 1))
            query = f"CREATE (n:Community {{id: '{esc_id}', name: '{esc_name}', size: {size}}});"
        elif label in ["File", "Folder"]:
            esc_path = escape_cypher_str(props.get("path", esc_file))
            query = f"CREATE (n:{label} {{id: '{esc_id}', name: '{esc_name}', path: '{esc_path}'}});"
        else:
            query = f"CREATE (n:{label} {{id: '{esc_id}', name: '{esc_name}', filePath: '{esc_file}'}});"

        try:
            conn.execute(query)
        except Exception:
            pass

    # 4. Populate Relationships
    relationships = graph_data.get("relationships", [])
    for rel in relationships:
        src_id = rel.get("sourceId")
        tgt_id = rel.get("targetId")
        r_type = rel.get("type", "CALLS")
        conf = float(rel.get("confidence", 1.0))
        reason = escape_cypher_str(rel.get("reason", ""))
        step = int(rel.get("step", 0))

        if src_id not in valid_node_ids or tgt_id not in valid_node_ids:
            continue

        src_lbl = node_types.get(src_id, "CodeElement")
        tgt_lbl = node_types.get(tgt_id, "CodeElement")

        esc_src = escape_cypher_str(src_id)
        esc_tgt = escape_cypher_str(tgt_id)

        rel_query = f"""
        MATCH (a:{src_lbl} {{id: '{esc_src}'}}), (b:{tgt_lbl} {{id: '{esc_tgt}'}})
        CREATE (a)-[r:CodeRelation {{type: '{r_type}', confidence: {conf}, reason: '{reason}', step: {step}}}]->(b);
        """
        try:
            conn.execute(rel_query)
        except Exception:
            pass

    # 5. Write .gitnexus/meta.json
    stats = graph_data.get("stats", {})
    meta = {
        "repoPath": str(target_path),
        "indexedAt": graph_data.get("indexedAt", ""),
        "lspEnriched": graph_data.get("lspEnriched", True),
        "database": {
            "type": "ladybug",
            "path": ".gitnexus/lbug",
            "schemaVersion": "1.0.0"
        },
        "stats": {
            "files": stats.get("files", len(nodes)),
            "nodes": len(nodes),
            "edges": len(relationships),
            "communities": stats.get("communities", 0),
            "processes": stats.get("processes", 0)
        }
    }
    with open(meta_file, "w", encoding="utf-8") as f:
        json.dump(meta, f, indent=2)

    print(f"✓ Successfully built .gitnexus/lbug and meta.json for {target_path}")

if __name__ == "__main__":
    target = sys.argv[1] if len(sys.argv) > 1 else "sample_projects/spring-boot-demo"
    build_lbug_from_graph(target)
