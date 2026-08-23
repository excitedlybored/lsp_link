#!/usr/bin/env python3
"""
Enterprise Business Workflow & Architecture Pipeline.

Transforms Knowledge Graph into unified, end-to-end business workflows:
  Stage 1: Knowledge Graph ──► workflow.json (Unified Route ──► Controller ──► Service ──► Egress Flows)
  Stage 2: workflow.json   ──► workflow.mmd  (High-Value Themed Mermaid Flowcharts)
  Stage 3: workflow.mmd    ──► workflow.svg  (Crisp Horizontal Vector Workflow Cards)
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

def classify_role(node_name: str, file_path: str, label: str) -> str:
    p_lower = file_path.lower()
    if label == "Route" or "ingress" in p_lower or "listener" in p_lower or "consumer" in p_lower:
        return "Ingress"
    if "egress" in p_lower or "client" in p_lower or "producer" in p_lower or "repo" in p_lower or "store" in p_lower:
        return "Egress"
    if "workflow" in p_lower or "controller" in p_lower:
        return "Controller"
    return "Service"

def clean_name(name: str) -> str:
    if not name:
        return "Process"
    return re.sub(r'#\d+$', '', name)

# ============================================================================
# STAGE 1: Extract Knowledge Graph ──► workflow.json (Unified End-to-End Flows)
# ============================================================================

def extract_workflow_json(project_dir: Path, output_json_path: Path) -> Dict[str, Any]:
    """Stage 1: Build high-value unified business workflows by linking Routes, Controllers, Services, and Egress."""
    gitnexus_dir = project_dir / ".gitnexus"
    graph_file = gitnexus_dir / "graph.json"

    if not graph_file.exists():
        raise FileNotFoundError(f"graph.json not found in '{gitnexus_dir}'")

    with open(graph_file, "r", encoding="utf-8") as f:
        graph_data = json.load(f)

    all_nodes = {n["id"]: n for n in graph_data.get("nodes", [])}
    raw_relationships = graph_data.get("relationships", [])

    # Map Route -> Handler Method
    route_to_handler: Dict[str, str] = {}
    handler_to_routes: Dict[str, List[str]] = {}

    for n in all_nodes.values():
        if n.get("label") == "Route":
            r_id = n["id"]
            handler_id = n.get("properties", {}).get("handlerSymbolId", "")
            if handler_id and handler_id in all_nodes:
                route_to_handler[r_id] = handler_id
                handler_to_routes.setdefault(handler_id, []).append(r_id)

    for r in raw_relationships:
        if r.get("type") in ["HANDLES_ROUTE", "HANDLES"]:
            src = r.get("sourceId")
            tgt = r.get("targetId")
            if src in all_nodes and tgt in all_nodes:
                route_to_handler[src] = tgt
                handler_to_routes.setdefault(tgt, []).append(src)

    # Build Call Graph Adjacency
    call_adjacency: Dict[str, List[str]] = {}
    for r in raw_relationships:
        if r.get("type") == "CALLS":
            src = r.get("sourceId")
            tgt = r.get("targetId")
            if src in all_nodes and tgt in all_nodes:
                # Ignore self-loops
                if src != tgt:
                    call_adjacency.setdefault(src, []).append(tgt)

    # Identify Primary Workflow Entry Points (Routes, Listeners, Sagas, Workflows)
    entry_points = []
    
    # 1. Add all Routes that have handlers or calls
    for r_node in all_nodes.values():
        if r_node.get("label") == "Route":
            entry_points.append(r_node)

    # 2. Add Message Queue Consumers & Listeners (not already covered by Routes)
    for n in all_nodes.values():
        if n.get("label") in ["Method", "Function"]:
            f_path = n.get("properties", {}).get("filePath", "").lower()
            name = n.get("properties", {}).get("name", "")
            if ("listener" in f_path or "consumer" in f_path or "workflow" in f_path or "processor" in f_path) and ("test" not in f_path):
                if n["id"] not in handler_to_routes:
                    entry_points.append(n)

    workflows = []
    seen_flow_signatures = set()

    for idx, entry in enumerate(entry_points, 1):
        e_id = entry["id"]
        props = entry.get("properties", {})
        e_label = entry.get("label", "Method")
        raw_name = props.get("name", e_id.split(":")[-1])
        e_name = clean_name(raw_name)
        e_file = props.get("filePath", props.get("path", ""))

        # Determine Route Info
        if e_label == "Route":
            route_path = props.get("name", e_id.split(":")[-1])
            http_method = props.get("method", "GET")
            handler_id = route_to_handler.get(e_id)
            handler_node = all_nodes.get(handler_id) if handler_id else None
            
            # Start search from handler if route points to handler
            start_search_ids = [handler_id] if handler_node else []
            if not start_search_ids:
                full_route_file = project_dir / e_file
                if full_route_file.exists():
                    try:
                        with open(full_route_file, "r", encoding="utf-8", errors="ignore") as rf:
                            route_text = rf.read()
                            for m_node in all_nodes.values():
                                if m_node.get("label") in ["Method", "Function"]:
                                    m_name = m_node.get("properties", {}).get("name", "")
                                    if m_name and len(m_name) > 3 and m_name in route_text and m_node.get("properties", {}).get("filePath") != e_file:
                                        start_search_ids.append(m_node["id"])
                    except Exception:
                        pass
            if not start_search_ids:
                start_search_ids = [e_id]

            wf_title = f"{http_method} {route_path}"
            entry_summary = {
                "id": e_id,
                "name": f"{http_method} {route_path}",
                "role": "Ingress",
                "filePath": handler_node.get("properties", {}).get("filePath", e_file) if handler_node else e_file,
                "handlerName": clean_name(handler_node.get("properties", {}).get("name", "")) if handler_node else ""
            }
        else:
            start_search_ids = [e_id]
            wf_title = f"Event: {e_name}"
            entry_summary = {
                "id": e_id,
                "name": e_name,
                "role": "Ingress",
                "filePath": e_file,
                "handlerName": e_name
            }

        # Traverse downstream call graph from start_search_ids
        visited = set()
        queue = [(sid, 0) for sid in start_search_ids]
        workflow_controllers = []
        workflow_services = []
        workflow_egress = []

        # If entry is a Route with a handler, add handler as controller
        if e_label == "Route" and handler_node:
            h_props = handler_node.get("properties", {})
            h_name = clean_name(h_props.get("name", handler_id.split(":")[-1]))
            workflow_controllers.append({
                "id": handler_id,
                "name": h_name,
                "role": "Controller",
                "filePath": h_props.get("filePath", ""),
                "type": handler_node.get("label", "Method")
            })

        while queue:
            curr_id, depth = queue.pop(0)
            if curr_id in visited or depth > 4:
                continue
            visited.add(curr_id)

            curr_node = all_nodes.get(curr_id)
            if not curr_node:
                continue

            curr_props = curr_node.get("properties", {})
            curr_name = clean_name(curr_props.get("name", curr_id.split(":")[-1]))
            curr_file = curr_props.get("filePath", curr_props.get("path", ""))
            curr_role = classify_role(curr_name, curr_file, curr_node.get("label", ""))

            # Filter out File nodes or noise
            if curr_node.get("label") in ["File", "Folder", "Community", "Process"]:
                continue

            if curr_id not in start_search_ids and curr_id != e_id:
                step_item = {
                    "id": curr_id,
                    "name": curr_name,
                    "role": curr_role,
                    "filePath": curr_file,
                    "type": curr_node.get("label", "Method")
                }
                if curr_role == "Egress":
                    if not any(eg["name"] == curr_name for eg in workflow_egress):
                        workflow_egress.append(step_item)
                elif curr_role == "Controller":
                    if not any(c["name"] == curr_name for c in workflow_controllers):
                        workflow_controllers.append(step_item)
                else:
                    if not any(s["name"] == curr_name for s in workflow_services):
                        workflow_services.append(step_item)

            for nxt in call_adjacency.get(curr_id, []):
                if nxt not in visited:
                    queue.append((nxt, depth + 1))

        # Only keep meaningful workflows that have downstream actions or explicit routes
        if not workflow_controllers and not workflow_services and not workflow_egress:
            continue

        # Prevent duplicate workflows
        sig = (entry_summary["name"], tuple(s["name"] for s in workflow_services), tuple(e["name"] for e in workflow_egress))
        if sig in seen_flow_signatures:
            continue
        seen_flow_signatures.add(sig)

        workflows.append({
            "id": f"wf_{idx}_{re.sub(r'[^a-zA-Z0-9]', '_', entry_summary['name']).lower()}",
            "title": wf_title,
            "ingress": entry_summary,
            "controllers": workflow_controllers,
            "services": workflow_services,
            "egressSinks": workflow_egress,
            "totalSteps": 1 + len(workflow_controllers) + len(workflow_services) + len(workflow_egress)
        })

    result = {
        "project": str(project_dir),
        "totalWorkflows": len(workflows),
        "workflows": workflows
    }

    with open(output_json_path, "w", encoding="utf-8") as f:
        json.dump(result, f, indent=2)

    return result

# ============================================================================
# STAGE 2: workflow.json ──► workflow.mmd (Themed Mermaid Workflow Subgraphs)
# ============================================================================

def sanitize_id(node_id: str) -> str:
    return re.sub(r'[^a-zA-Z0-9_]', '_', node_id)

def convert_json_to_mmd(workflow_json_path: Path, output_mmd_path: Path) -> str:
    """Stage 2: Convert business workflows into clean, horizontal Mermaid flowcharts."""
    with open(workflow_json_path, "r", encoding="utf-8") as f:
        data = json.load(f)

    workflows = data.get("workflows", [])
    mmd = [
        "%%{init: {'theme': 'dark', 'themeVariables': { 'darkMode': true, 'primaryColor': '#1e293b', 'edgeLabelBackground':'#0f172a'}}}%%",
        "flowchart TD",
        "    classDef ingress fill:#065f46,stroke:#10b981,stroke-width:2.5px,color:#ecfdf5,font-weight:bold;",
        "    classDef controller fill:#1e3a8a,stroke:#3b82f6,stroke-width:2px,color:#eff6ff;",
        "    classDef service fill:#1e293b,stroke:#38bdf8,stroke-width:2px,color:#f0f9ff;",
        "    classDef egress fill:#7f1d1d,stroke:#ef4444,stroke-width:2.5px,color:#fef2f2,font-weight:bold;",
        ""
    ]

    for w_idx, wf in enumerate(workflows, 1):
        wf_id = sanitize_id(wf["id"])
        wf_title = html.escape(wf["title"])
        mmd.append(f"    subgraph {wf_id} [\"⚡ WORKFLOW {w_idx}: {wf_title}\"]")
        mmd.append("        direction LR")

        ing = wf["ingress"]
        ing_id = f"{wf_id}_IN"
        ing_file = Path(ing.get("filePath", "")).name
        mmd.append(f"        {ing_id}[\"🟢 INGRESS: {ing['name']}<br/><small>{ing_file}</small>\"]:::ingress")

        prev_ids = [ing_id]

        # Controllers
        ctrls = wf.get("controllers", [])
        if ctrls:
            new_prevs = []
            for c_idx, ctrl in enumerate(ctrls[:2]):
                c_node_id = f"{wf_id}_CTRL_{c_idx}"
                c_file = Path(ctrl.get("filePath", "")).name
                mmd.append(f"        {c_node_id}[\"🎮 CONTROLLER: {ctrl['name']}<br/><small>{c_file}</small>\"]:::controller")
                for p_id in prev_ids:
                    mmd.append(f"        {p_id} --> {c_node_id}")
                new_prevs.append(c_node_id)
            prev_ids = new_prevs

        # Services
        svcs = wf.get("services", [])
        if svcs:
            new_prevs = []
            for s_idx, svc in enumerate(svcs[:2]):
                s_node_id = f"{wf_id}_SVC_{s_idx}"
                s_file = Path(svc.get("filePath", "")).name
                mmd.append(f"        {s_node_id}[\"⚙️ SERVICE: {svc['name']}<br/><small>{s_file}</small>\"]:::service")
                for p_id in prev_ids:
                    mmd.append(f"        {p_id} --> {s_node_id}")
                new_prevs.append(s_node_id)
            prev_ids = new_prevs

        # Egress Sinks (fan-out)
        egs = wf.get("egressSinks", [])
        if egs:
            for e_idx, eg in enumerate(egs[:3]):
                e_node_id = f"{wf_id}_EG_{e_idx}"
                e_file = Path(eg.get("filePath", "")).name
                mmd.append(f"        {e_node_id}[\"🔴 EGRESS: {eg['name']}<br/><small>{e_file}</small>\"]:::egress")
                for p_id in prev_ids:
                    mmd.append(f"        {p_id} --> {e_node_id}")

        mmd.append("    end")
        mmd.append("")

    mmd_content = "\n".join(mmd)
    with open(output_mmd_path, "w", encoding="utf-8") as f:
        f.write(mmd_content)

    return mmd_content

# ============================================================================
# STAGE 3: workflow.mmd ──► workflow.svg (Card-Based Horizontal Workflow Graphic)
# ============================================================================

def convert_mmd_to_svg(workflow_mmd_path: Path, output_svg_path: Path) -> str:
    """Stage 3: Render Mermaid workflow subgraphs as horizontal visual transaction cards."""
    with open(workflow_mmd_path, "r", encoding="utf-8") as f:
        mmd_text = f.read()

    subgraphs = []
    current_subgraph = None

    for line in mmd_text.splitlines():
        line = line.strip()
        if line.startswith("subgraph"):
            m = re.search(r'subgraph\s+(\w+)\s+\["(.+?)"\]', line)
            if m:
                current_subgraph = {
                    "id": m.group(1),
                    "title": m.group(2),
                    "nodes": [],
                    "edges": []
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
                title_part = parts[0].replace("🟢 ", "").replace("🔴 ", "").replace("🎮 ", "").replace("⚙️ ", "")
                sub_part = parts[1].replace("</small>", "") if len(parts) > 1 else ""

                current_subgraph["nodes"].append({
                    "id": n_id,
                    "title": title_part,
                    "sub": sub_part,
                    "class": cls
                })
            elif "-->" in line and not line.startswith("%%"):
                e_match = re.search(r'(\w+)\s+-->\s+(\w+)', line)
                if e_match:
                    current_subgraph["edges"].append((e_match.group(1), e_match.group(2)))

    svg_width = 1100
    card_height = 145
    card_gap = 25
    svg_height = max(400, len(subgraphs) * (card_height + card_gap) + 120)

    svg = [
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {svg_width} {svg_height}" width="{svg_width}" height="{svg_height}">',
        '  <defs>',
        '    <linearGradient id="bgGrad" x1="0%" y1="0%" x2="100%" y2="100%">',
        '      <stop offset="0%" stop-color="#0b1120"/>',
        '      <stop offset="100%" stop-color="#1e293b"/>',
        '    </linearGradient>',
        '    <marker id="arrow" viewBox="0 0 10 10" refX="6" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">',
        '      <path d="M 0 1 L 10 5 L 0 9 z" fill="#38bdf8"/>',
        '    </marker>',
        '  </defs>',
        f'  <rect width="{svg_width}" height="{svg_height}" fill="url(#bgGrad)"/>',
        f'  <text x="35" y="45" fill="#38bdf8" font-family="system-ui, -apple-system, sans-serif" font-size="20" font-weight="bold">⚡ LSP-Link End-to-End Business Transaction Workflows</text>',
        f'  <text x="35" y="70" fill="#94a3b8" font-family="system-ui, -apple-system, sans-serif" font-size="12">Rendered from workflow.mmd | Discovered Business Workflows: {len(subgraphs)}</text>',
    ]

    y_offset = 95
    for sg_idx, sg in enumerate(subgraphs, 1):
        nodes_list = sg["nodes"]
        num_nodes = len(nodes_list)
        
        svg.append(f'  <!-- Workflow Card {sg_idx}: {sg["id"]} -->')
        svg.append(f'  <g transform="translate(35, {y_offset})">')
        svg.append(f'    <rect width="1030" height="{card_height}" rx="10" fill="#1e293b" stroke="#334155" stroke-width="1.5"/>')
        svg.append(f'    <text x="20" y="26" fill="#f59e0b" font-family="system-ui, sans-serif" font-size="13" font-weight="bold">{html.escape(sg["title"])}</text>')

        if num_nodes > 0:
            box_width = min(230, (970 - (num_nodes - 1) * 35) // max(1, num_nodes))
            node_coords = {}

            for n_idx, nd in enumerate(nodes_list):
                x_pos = 20 + n_idx * (box_width + 35)
                y_box = 45
                box_h = 75

                cls = nd["class"]
                fill_col = "#065f46" if cls == "ingress" else ("#7f1d1d" if cls == "egress" else ("#1e3a8a" if cls == "controller" else "#0f172a"))
                border_col = "#10b981" if cls == "ingress" else ("#ef4444" if cls == "egress" else ("#3b82f6" if cls == "controller" else "#38bdf8"))
                badge_txt = "INGRESS" if cls == "ingress" else ("EGRESS SINK" if cls == "egress" else ("CONTROLLER" if cls == "controller" else "SERVICE"))

                svg.append(f'    <!-- Step Node {n_idx} -->')
                svg.append(f'    <rect x="{x_pos}" y="{y_box}" width="{box_width}" height="{box_h}" rx="6" fill="{fill_col}" stroke="{border_col}" stroke-width="1.8"/>')
                svg.append(f'    <rect x="{x_pos+8}" y="{y_box+8}" width="72" height="14" rx="3" fill="{border_col}" fill-opacity="0.25"/>')
                svg.append(f'    <text x="{x_pos+12}" y="{y_box+19}" fill="{border_col}" font-family="system-ui, sans-serif" font-size="8.5" font-weight="bold">{badge_txt}</text>')
                
                safe_title = html.escape(nd["title"])
                if len(safe_title) > 20:
                    safe_title = safe_title[:18] + "…"
                svg.append(f'    <text x="{x_pos+8}" y="{y_box+43}" fill="#f8fafc" font-family="system-ui, sans-serif" font-size="11.5" font-weight="600">{safe_title}</text>')
                
                safe_sub = html.escape(nd["sub"])
                if len(safe_sub) > 24:
                    safe_sub = safe_sub[:22] + "…"
                svg.append(f'    <text x="{x_pos+8}" y="{y_box+61}" fill="#94a3b8" font-family="system-ui, sans-serif" font-size="10">{safe_sub}</text>')

                node_coords[nd["id"]] = (x_pos, y_box, box_width, box_h)

            # Draw Connecting Arrows
            for src_id, tgt_id in sg["edges"]:
                if src_id in node_coords and tgt_id in node_coords:
                    x1, y1, w1, h1 = node_coords[src_id]
                    x2, y2, w2, h2 = node_coords[tgt_id]
                    start_x = x1 + w1
                    end_x = x2
                    mid_y = y1 + h1 // 2
                    svg.append(f'    <line x1="{start_x}" y1="{mid_y}" x2="{end_x}" y2="{mid_y}" stroke="#38bdf8" stroke-width="2" marker-end="url(#arrow)"/>')

        svg.append('  </g>')
        y_offset += (card_height + card_gap)

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
    print("🔄 ENTERPRISE BUSINESS WORKFLOW PIPELINE")
    print(f"   Target:  {proj_path}")
    print(f"   Outputs: {out_path}")
    print("==================================================")

    # Stage 1: Graph -> workflow.json
    print("⚙️  [1/3] Extracting unified business workflows ──► workflow.json...")
    res = extract_workflow_json(proj_path, json_file)
    print(f"   ✓ {json_file.name} ({res['totalWorkflows']} Cohesive Business Workflows)")

    # Stage 2: workflow.json -> workflow.mmd
    print("📊 [2/3] Generating Mermaid flowcharts ──► workflow.mmd...")
    convert_json_to_mmd(json_file, mmd_file)
    print(f"   ✓ {mmd_file.name} ({mmd_file.stat().st_size} bytes)")

    # Stage 3: workflow.mmd -> workflow.svg
    print("🖼️  [3/3] Rendering horizontal workflow cards ──► workflow.svg...")
    convert_mmd_to_svg(mmd_file, svg_file)
    print(f"   ✓ {svg_file.name} ({svg_file.stat().st_size} bytes)")

    print("==================================================")
    print("✅ Workflow Pipeline Completed Successfully!")
    print("==================================================")

if __name__ == "__main__":
    target = sys.argv[1] if len(sys.argv) > 1 else "examples/01_spring_boot_banking"
    out = sys.argv[2] if len(sys.argv) > 2 else None
    run_workflow_pipeline(target, out)
