#!/usr/bin/env python3
"""
Architectural Ingress & Egress Dependency Call Graph Exporter.

Sequential 3-Stage Transformation Pipeline:
  Stage 1: LadybugDB / Knowledge Graph ──► workflow.json (Explicit Ingress & Egress Boundaries + Call Trees)
  Stage 2: workflow.json               ──► workflow.mmd  (Layered Ingress ──► Service ──► Egress Diagram)
  Stage 3: workflow.mmd                ──► workflow.svg  (Multi-Layer Topology Vector Graphic)
"""

import sys
import os
import json
import re
import html
from pathlib import Path
from typing import List, Dict, Any, Set, Tuple

# Load SDK Registry for Ingress & Egress Classification
REGISTRY_PATH = Path(__file__).parent / "sdk_registry.json"

def load_sdk_registry() -> Dict[str, Any]:
    if REGISTRY_PATH.exists():
        with open(REGISTRY_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    return {"ingress": [], "egress": []}

def classify_node_boundary(node: Dict[str, Any], file_content_map: Dict[str, str], sdk_rules: Dict[str, Any]) -> str:
    """Classify a node into Ingress, Egress, Controller, or Service based on SDK rules and file context."""
    label = node.get("label", "")
    props = node.get("properties", {})
    f_path = props.get("filePath", props.get("path", ""))
    p_lower = f_path.lower()
    name = props.get("name", "")

    # 1. Direct Route Label is Ingress
    if label == "Route":
        return "Ingress"

    # 2. Check File Path Conventions
    if "ingress" in p_lower or "controller" in p_lower or "listener" in p_lower or "consumer" in p_lower:
        if "controller" in p_lower:
            return "Controller"
        return "Ingress"

    if "egress" in p_lower or "client" in p_lower or "producer" in p_lower or "repository" in p_lower or "store" in p_lower:
        return "Egress"

    if "workflow" in p_lower:
        return "Controller"

    # 3. Check File Content against SDK Registry
    content = file_content_map.get(f_path, "")
    if content:
        for rule in sdk_rules.get("egress", []):
            if re.search(rule["pattern"], content):
                return "Egress"
        for rule in sdk_rules.get("ingress", []):
            if re.search(rule["pattern"], content):
                return "Ingress"

    return "Domain_Service"

# ============================================================================
# STAGE 1: Extract Knowledge Graph ──► workflow.json (Ingress & Egress Call Graph)
# ============================================================================

def extract_workflow_json(project_dir: Path, output_json_path: Path) -> Dict[str, Any]:
    """Stage 1: Extract true Ingress-to-Egress call graph from LadybugDB/graph.json."""
    gitnexus_dir = project_dir / ".gitnexus"
    graph_file = gitnexus_dir / "graph.json"

    if not graph_file.exists():
        raise FileNotFoundError(f"graph.json not found in '{gitnexus_dir}'")

    with open(graph_file, "r", encoding="utf-8") as f:
        graph_data = json.load(f)

    all_nodes = {n["id"]: n for n in graph_data.get("nodes", [])}
    raw_relationships = graph_data.get("relationships", [])
    sdk_rules = load_sdk_registry()

    # Pre-cache source file contents for SDK detection
    file_content_map = {}
    for n in all_nodes.values():
        fp = n.get("properties", {}).get("filePath", "")
        if fp and fp not in file_content_map:
            full_p = project_dir / fp
            if full_p.exists() and full_p.is_file():
                try:
                    with open(full_p, "r", encoding="utf-8", errors="ignore") as src_f:
                        file_content_map[fp] = src_f.read()
                except Exception:
                    file_content_map[fp] = ""

    # Filter relevant call & route handling relationships
    call_rels = []
    active_node_ids = set()

    for r in raw_relationships:
        r_type = r.get("type", "")
        if r_type in ["CALLS", "HANDLES_ROUTE", "STEP_IN_PROCESS"]:
            s_id = r.get("sourceId")
            t_id = r.get("targetId")
            if s_id in all_nodes and t_id in all_nodes:
                call_rels.append({
                    "source": s_id,
                    "target": t_id,
                    "type": r_type,
                    "confidence": float(r.get("confidence", 1.0)),
                    "reason": r.get("reason", "")
                })
                active_node_ids.add(s_id)
                active_node_ids.add(t_id)

    # Deduplicate call relationships
    seen_edges = set()
    deduped_edges = []
    for edge in call_rels:
        key = (edge["source"], edge["target"], edge["type"])
        if key not in seen_edges:
            seen_edges.add(key)
            deduped_edges.append(edge)

    # Format active nodes with Ingress/Egress boundary classification
    graph_nodes = []
    ingress_points = []
    egress_points = []

    for n_id in active_node_ids:
        n = all_nodes[n_id]
        props = n.get("properties", {})
        f_path = props.get("filePath", props.get("path", ""))
        layer = classify_node_boundary(n, file_content_map, sdk_rules)

        node_item = {
            "id": n_id,
            "name": props.get("name", n_id.split(":")[-1]),
            "label": n.get("label", "CodeElement"),
            "layer": layer,
            "filePath": f_path,
            "startLine": props.get("startLine", 1),
            "endLine": props.get("endLine", 1),
        }
        graph_nodes.append(node_item)

        if layer == "Ingress":
            ingress_points.append(node_item)
        elif layer == "Egress":
            egress_points.append(node_item)

    # Build Adjacency Graph
    adjacency: Dict[str, List[str]] = {}
    for e in deduped_edges:
        if e["type"] in ["CALLS", "HANDLES_ROUTE"]:
            adjacency.setdefault(e["source"], []).append(e["target"])

    # Trace End-to-End Ingress ──► Egress Execution Paths
    egress_ids = {e["id"] for e in egress_points}
    ingress_to_egress_flows = []

    for root in ingress_points:
        root_id = root["id"]
        def trace_paths(curr_id, curr_path, visited, depth=0):
            if depth > 6 or curr_id in visited:
                return []
            if curr_id in egress_ids and len(curr_path) > 1:
                return [curr_path]
            next_nodes = adjacency.get(curr_id, [])
            flows = []
            for nxt in next_nodes:
                flows.extend(trace_paths(nxt, curr_path + [nxt], visited | {curr_id}, depth + 1))
            return flows

        found_flows = trace_paths(root_id, [root_id], set())
        for fl in found_flows:
            ingress_to_egress_flows.append({
                "ingress": root["name"],
                "ingressId": root_id,
                "egress": all_nodes.get(fl[-1], {}).get("properties", {}).get("name", fl[-1].split(":")[-1]),
                "egressId": fl[-1],
                "hops": len(fl) - 1,
                "path": [
                    {
                        "id": nid,
                        "name": all_nodes.get(nid, {}).get("properties", {}).get("name", nid.split(":")[-1]),
                        "layer": classify_node_boundary(all_nodes.get(nid, {}), file_content_map, sdk_rules),
                        "filePath": all_nodes.get(nid, {}).get("properties", {}).get("filePath", "")
                    }
                    for nid in fl
                ]
            })

    result = {
        "project": str(project_dir),
        "totalNodes": len(graph_nodes),
        "totalEdges": len(deduped_edges),
        "totalIngressPoints": len(ingress_points),
        "totalEgressPoints": len(egress_points),
        "totalIngressToEgressFlows": len(ingress_to_egress_flows),
        "ingressPoints": ingress_points,
        "egressPoints": egress_points,
        "nodes": graph_nodes,
        "edges": deduped_edges,
        "ingressToEgressFlows": ingress_to_egress_flows
    }

    with open(output_json_path, "w", encoding="utf-8") as f:
        json.dump(result, f, indent=2)

    return result

# ============================================================================
# STAGE 2: workflow.json ──► workflow.mmd (Ingress ──► Service ──► Egress Diagram)
# ============================================================================

def sanitize_id(node_id: str) -> str:
    """Generate safe Mermaid node identifiers."""
    return re.sub(r'[^a-zA-Z0-9_]', '_', node_id)

def convert_json_to_mmd(workflow_json_path: Path, output_mmd_path: Path) -> str:
    """Stage 2: Convert call graph JSON into an Ingress & Egress boundary Mermaid diagram."""
    with open(workflow_json_path, "r", encoding="utf-8") as f:
        data = json.load(f)

    nodes = data.get("nodes", [])
    edges = data.get("edges", [])

    layers = {
        "Ingress": [],
        "Controller": [],
        "Domain_Service": [],
        "Egress": []
    }

    for n in nodes:
        layer = n.get("layer", "Domain_Service")
        if layer not in layers:
            layer = "Domain_Service"
        layers[layer].append(n)

    mmd = [
        "%%{init: {'theme': 'dark', 'themeVariables': { 'darkMode': true, 'primaryColor': '#1e293b', 'edgeLabelBackground':'#0f172a'}}}%%",
        "flowchart LR",
        "    classDef ingress fill:#065f46,stroke:#10b981,stroke-width:2.5px,color:#ecfdf5,font-weight:bold;",
        "    classDef controller fill:#1e3a8a,stroke:#3b82f6,stroke-width:2px,color:#eff6ff;",
        "    classDef service fill:#1e293b,stroke:#38bdf8,stroke-width:2px,color:#f0f9ff;",
        "    classDef egress fill:#7f1d1d,stroke:#ef4444,stroke-width:2.5px,color:#fef2f2,font-weight:bold;",
        ""
    ]

    layer_titles = {
        "Ingress": "🟢 INGRESS BOUNDARIES (REST Endpoints & Consumers)",
        "Controller": "🎮 CONTROLLERS & WORKFLOWS",
        "Domain_Service": "⚙️ DOMAIN SERVICES & BUSINESS LOGIC",
        "Egress": "🔴 EGRESS BOUNDARIES (Databases, HTTP Clients & Publishers)"
    }

    for l_key, l_title in layer_titles.items():
        l_nodes = layers.get(l_key, [])
        if not l_nodes:
            continue
        mmd.append(f"    subgraph {l_key} [\"{l_title}\"]")
        for n in l_nodes:
            s_id = sanitize_id(n["id"])
            name = n["name"]
            f_name = Path(n.get("filePath", "")).name
            cls = "ingress" if l_key == "Ingress" else ("egress" if l_key == "Egress" else ("controller" if l_key == "Controller" else "service"))
            icon = "🟢 " if l_key == "Ingress" else ("🔴 " if l_key == "Egress" else ("🎮 " if l_key == "Controller" else "⚙️ "))
            mmd.append(f"        {s_id}[\"{icon}{name}<br/><small>{f_name}</small>\"]:::{cls}")
        mmd.append("    end")
        mmd.append("")

    # Add Dependency Call Arrows
    mmd.append("    %% Ingress to Egress Call Connections")
    for e in edges:
        if e.get("type") in ["CALLS", "HANDLES_ROUTE"]:
            src_safe = sanitize_id(e["source"])
            tgt_safe = sanitize_id(e["target"])
            label = "calls" if e["type"] == "CALLS" else "handles"
            mmd.append(f"    {src_safe} -->|{label}| {tgt_safe}")

    mmd_content = "\n".join(mmd)
    with open(output_mmd_path, "w", encoding="utf-8") as f:
        f.write(mmd_content)

    return mmd_content

# ============================================================================
# STAGE 3: workflow.mmd ──► workflow.svg (Ingress & Egress Topology Graphic)
# ============================================================================

def convert_mmd_to_svg(workflow_mmd_path: Path, output_svg_path: Path) -> str:
    """Stage 3: Render Ingress & Egress boundary topology directly to crisp SVG."""
    with open(workflow_mmd_path, "r", encoding="utf-8") as f:
        mmd_text = f.read()

    subgraphs = []
    current_subgraph = None
    all_nodes_dict = {}
    edges_list = []

    for line in mmd_text.splitlines():
        line = line.strip()
        if line.startswith("subgraph"):
            m = re.search(r'subgraph\s+(\w+)\s+\["(.+?)"\]', line)
            if m:
                current_subgraph = {
                    "id": m.group(1),
                    "title": m.group(2),
                    "nodes": []
                }
                subgraphs.append(current_subgraph)
        elif line.startswith("end") and current_subgraph:
            current_subgraph = None
        elif current_subgraph:
            node_match = re.search(r'(\w+)\["(.+?)"\](?::::(\w+))?', line)
            if node_match:
                n_id = node_match.group(1)
                raw_label = node_match.group(2)
                cls = node_match.group(3) or "service"

                parts = raw_label.split("<br/><small>")
                name = parts[0].replace("🟢 ", "").replace("🔴 ", "").replace("🎮 ", "").replace("⚙️ ", "")
                sub = parts[1].replace("</small>", "") if len(parts) > 1 else ""

                node_obj = {
                    "id": n_id,
                    "name": name,
                    "sub": sub,
                    "class": cls,
                    "layer": current_subgraph["id"]
                }
                current_subgraph["nodes"].append(node_obj)
                all_nodes_dict[n_id] = node_obj
        elif "-->" in line and not line.startswith("%%"):
            edge_match = re.search(r'(\w+)\s+-->(\|.+?\|)?\s+(\w+)', line)
            if edge_match:
                edges_list.append((edge_match.group(1), edge_match.group(3)))

    num_cols = len(subgraphs)
    col_width = 250
    col_gap = 60
    svg_width = max(1100, num_cols * (col_width + col_gap) + 80)
    
    max_nodes_in_col = max((len(sg["nodes"]) for sg in subgraphs), default=1)
    svg_height = max(520, max_nodes_in_col * 90 + 160)

    node_positions = {}
    for col_idx, sg in enumerate(subgraphs):
        x = 40 + col_idx * (col_width + col_gap)
        for row_idx, nd in enumerate(sg["nodes"]):
            y = 130 + row_idx * 85
            node_positions[nd["id"]] = {
                "x": x + 15,
                "y": y,
                "w": col_width - 30,
                "h": 65,
                "cx": x + 15 + (col_width - 30) // 2,
                "cy": y + 32,
                "right_x": x + 15 + (col_width - 30),
                "left_x": x + 15,
                "node": nd
            }

    svg = [
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {svg_width} {svg_height}" width="{svg_width}" height="{svg_height}">',
        '  <defs>',
        '    <linearGradient id="bgGrad" x1="0%" y1="0%" x2="100%" y2="100%">',
        '      <stop offset="0%" stop-color="#0b1120"/>',
        '      <stop offset="100%" stop-color="#1e293b"/>',
        '    </linearGradient>',
        '    <marker id="callArrow" viewBox="0 0 10 10" refX="6" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">',
        '      <path d="M 0 1 L 10 5 L 0 9 z" fill="#38bdf8"/>',
        '    </marker>',
        '  </defs>',
        f'  <rect width="{svg_width}" height="{svg_height}" fill="url(#bgGrad)"/>',
        f'  <text x="40" y="45" fill="#38bdf8" font-family="system-ui, -apple-system, sans-serif" font-size="20" font-weight="bold">⚡ LSP-Link Ingress ──► Egress Boundary Topology</text>',
        f'  <text x="40" y="70" fill="#94a3b8" font-family="system-ui, -apple-system, sans-serif" font-size="12">Rendered from workflow.mmd | Layers: {num_cols} | Boundary Points & Nodes: {len(all_nodes_dict)} | Dependencies: {len(edges_list)}</text>',
    ]

    for col_idx, sg in enumerate(subgraphs):
        x = 40 + col_idx * (col_width + col_gap)
        col_h = max_nodes_in_col * 85 + 40
        header_col = "#10b981" if sg["id"] == "Ingress" else ("#ef4444" if sg["id"] == "Egress" else "#f59e0b")
        svg.append(f'  <!-- Layer Column: {sg["id"]} -->')
        svg.append(f'  <rect x="{x}" y="95" width="{col_width}" height="{col_h}" rx="8" fill="#1e293b" fill-opacity="0.5" stroke="#334155" stroke-dasharray="4"/>')
        svg.append(f'  <text x="{x+15}" y="118" fill="{header_col}" font-family="system-ui, sans-serif" font-size="11" font-weight="bold">{html.escape(sg["title"])}</text>')

    svg.append('  <!-- Call Dependency Arrows -->')
    for src_id, tgt_id in edges_list:
        if src_id in node_positions and tgt_id in node_positions:
            p1 = node_positions[src_id]
            p2 = node_positions[tgt_id]
            x1, y1 = p1["right_x"], p1["cy"]
            x2, y2 = p2["left_x"], p2["cy"]
            dx = max(30, abs(x2 - x1) * 0.4)
            svg.append(f'  <path d="M {x1} {y1} C {x1+dx} {y1}, {x2-dx} {y2}, {x2} {y2}" fill="none" stroke="#38bdf8" stroke-width="1.8" stroke-opacity="0.85" marker-end="url(#callArrow)"/>')

    svg.append('  <!-- Boundary Nodes -->')
    for n_id, pos in node_positions.items():
        nd = pos["node"]
        cls = nd["class"]
        x, y, w, h = pos["x"], pos["y"], pos["w"], pos["h"]

        fill_col = "#065f46" if cls == "ingress" else ("#7f1d1d" if cls == "egress" else ("#1e3a8a" if cls == "controller" else "#0f172a"))
        border_col = "#10b981" if cls == "ingress" else ("#ef4444" if cls == "egress" else ("#3b82f6" if cls == "controller" else "#38bdf8"))
        badge_txt = "INGRESS POINT" if cls == "ingress" else ("EGRESS SINK" if cls == "egress" else ("CONTROLLER" if cls == "controller" else "SERVICE"))

        svg.append(f'  <g>')
        svg.append(f'    <rect x="{x}" y="{y}" width="{w}" height="{h}" rx="6" fill="{fill_col}" stroke="{border_col}" stroke-width="1.8"/>')
        svg.append(f'    <rect x="{x+8}" y="{y+7}" width="72" height="13" rx="3" fill="{border_col}" fill-opacity="0.25"/>')
        svg.append(f'    <text x="{x+12}" y="{y+17}" fill="{border_col}" font-family="system-ui, sans-serif" font-size="8" font-weight="bold">{badge_txt}</text>')
        
        safe_name = html.escape(nd["name"])
        if len(safe_name) > 20:
            safe_name = safe_name[:18] + "…"
        svg.append(f'    <text x="{x+8}" y="{y+36}" fill="#f8fafc" font-family="system-ui, sans-serif" font-size="11" font-weight="600">{safe_name}</text>')
        
        safe_sub = html.escape(nd["sub"])
        if len(safe_sub) > 24:
            safe_sub = safe_sub[:22] + "…"
        svg.append(f'    <text x="{x+8}" y="{y+52}" fill="#94a3b8" font-family="system-ui, sans-serif" font-size="9.5">{safe_sub}</text>')
        svg.append(f'  </g>')

    svg.append('</svg>')
    svg_content = "\n".join(svg)

    with open(output_svg_path, "w", encoding="utf-8") as f:
        f.write(svg_content)

    return svg_content

# ============================================================================
# MASTER 3-STAGE PIPELINE RUNNER
# ============================================================================

def run_workflow_pipeline(project_dir: str, output_dir: str = None):
    proj_path = Path(project_dir).resolve()
    out_path = Path(output_dir).resolve() if output_dir else proj_path / ".gitnexus"
    out_path.mkdir(parents=True, exist_ok=True)

    json_file = out_path / "workflow.json"
    mmd_file = out_path / "workflow.mmd"
    svg_file = out_path / "workflow.svg"

    print("==================================================")
    print("🔄 INGRESS & EGRESS DEPENDENCY CALL GRAPH PIPELINE")
    print(f"   Target:  {proj_path}")
    print(f"   Outputs: {out_path}")
    print("==================================================")

    # Stage 1: Graph -> workflow.json
    print("⚙️  [1/3] Extracting Ingress & Egress boundaries ──► workflow.json...")
    res = extract_workflow_json(proj_path, json_file)
    print(f"   ✓ {json_file.name} ({res['totalIngressPoints']} Ingress, {res['totalEgressPoints']} Egress, {res['totalIngressToEgressFlows']} End-to-End Flows)")

    # Stage 2: workflow.json -> workflow.mmd
    print("📊 [2/3] Generating Ingress ──► Egress diagram ──► workflow.mmd...")
    convert_json_to_mmd(json_file, mmd_file)
    print(f"   ✓ {mmd_file.name} ({mmd_file.stat().st_size} bytes)")

    # Stage 3: workflow.mmd -> workflow.svg
    print("🖼️  [3/3] Rendering multi-layer vector topology ──► workflow.svg...")
    convert_mmd_to_svg(mmd_file, svg_file)
    print(f"   ✓ {svg_file.name} ({svg_file.stat().st_size} bytes)")

    print("==================================================")
    print("✅ Ingress & Egress Boundary Pipeline Completed!")
    print("==================================================")

if __name__ == "__main__":
    target = sys.argv[1] if len(sys.argv) > 1 else "sample_projects/spring-boot-demo"
    out = sys.argv[2] if len(sys.argv) > 2 else None
    run_workflow_pipeline(target, out)
