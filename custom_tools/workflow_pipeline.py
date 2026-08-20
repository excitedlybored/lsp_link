#!/usr/bin/env python3
"""
Sequential 3-Stage Workflow Transformation Pipeline.

Pipeline Architecture:
  Stage 1: Graph Engine (LadybugDB) ──► workflow.json
  Stage 2: workflow.json            ──► workflow.mmd (Mermaid)
  Stage 3: workflow.mmd             ──► workflow.svg (SVG Vector Graphic)

Each stage is decoupled, inspectable, and can run independently.
"""

import sys
import os
import json
import re
import html
from pathlib import Path
from typing import List, Dict, Any

# ============================================================================
# STAGE 1: Extract Knowledge Graph ──► workflow.json
# ============================================================================

def extract_workflow_json(project_dir: Path, output_json_path: Path) -> Dict[str, Any]:
    """Stage 1: Query LadybugDB/graph.json and write workflow.json."""
    gitnexus_dir = project_dir / ".gitnexus"
    graph_file = gitnexus_dir / "graph.json"

    if not graph_file.exists():
        raise FileNotFoundError(f"graph.json not found in '{gitnexus_dir}'")

    with open(graph_file, "r", encoding="utf-8") as f:
        graph_data = json.load(f)

    nodes = {n["id"]: n for n in graph_data.get("nodes", [])}
    relationships = graph_data.get("relationships", [])

    process_nodes = [n for n in nodes.values() if n.get("label") == "Process"]
    workflows = []

    for idx, p in enumerate(process_nodes, 1):
        p_id = p["id"]
        props = p.get("properties", {})
        label = props.get("label", f"Workflow {idx}")
        ep_id = props.get("entryPointId", "")
        term_id = props.get("terminalId", "")

        step_rels = [
            r for r in relationships 
            if r.get("targetId") == p_id and r.get("type") == "STEP_IN_PROCESS"
        ]
        step_rels.sort(key=lambda r: int(r.get("step", 0)))

        step_nodes = []
        for r in step_rels:
            s_id = r.get("sourceId")
            if s_id in nodes:
                sn = nodes[s_id]
                step_nodes.append({
                    "id": sn["id"],
                    "name": sn.get("properties", {}).get("name", s_id.split(":")[-1]),
                    "type": sn.get("label", "Method"),
                    "filePath": sn.get("properties", {}).get("filePath", ""),
                    "step": int(r.get("step", 0))
                })

        workflows.append({
            "id": p_id,
            "label": label,
            "entryPoint": {
                "id": ep_id,
                "name": nodes.get(ep_id, {}).get("properties", {}).get("name", ep_id.split(":")[-1]),
                "filePath": nodes.get(ep_id, {}).get("properties", {}).get("filePath", "")
            },
            "terminalSink": {
                "id": term_id,
                "name": nodes.get(term_id, {}).get("properties", {}).get("name", term_id.split(":")[-1]),
                "filePath": nodes.get(term_id, {}).get("properties", {}).get("filePath", "")
            },
            "stepCount": len(step_nodes),
            "steps": step_nodes
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
# STAGE 2: workflow.json ──► workflow.mmd
# ============================================================================

def convert_json_to_mmd(workflow_json_path: Path, output_mmd_path: Path) -> str:
    """Stage 2: Read workflow.json and convert into standard Mermaid diagram."""
    with open(workflow_json_path, "r", encoding="utf-8") as f:
        data = json.load(f)

    workflows = data.get("workflows", [])
    mmd_lines = [
        "%%{init: {'theme': 'dark', 'themeVariables': { 'darkMode': true, 'primaryColor': '#1e293b', 'edgeLabelBackground':'#0f172a'}}}%%",
        "flowchart TD",
        "    classDef ingress fill:#065f46,stroke:#10b981,stroke-width:2px,color:#ecfdf5;",
        "    classDef service fill:#1e293b,stroke:#38bdf8,stroke-width:2px,color:#f0f9ff;",
        "    classDef egress fill:#7f1d1d,stroke:#ef4444,stroke-width:2px,color:#fef2f2;",
        ""
    ]

    for w_idx, wf in enumerate(workflows, 1):
        wf_safe_id = f"WF_{w_idx}"
        mmd_lines.append(f"    subgraph {wf_safe_id} [\"⚡ {wf['label']}\"]")
        steps = wf.get("steps", [])
        if not steps:
            ep_name = wf.get("entryPoint", {}).get("name", "Entry")
            term_name = wf.get("terminalSink", {}).get("name", "Exit")
            mmd_lines.append(f"        {wf_safe_id}_EP[\"🏁 {ep_name}\"]:::ingress --> {wf_safe_id}_TERM[\"🛑 {term_name}\"]:::egress")
        else:
            for s_idx, st in enumerate(steps):
                st_id = f"{wf_safe_id}_S{s_idx}"
                cls = "ingress" if s_idx == 0 else ("egress" if s_idx == len(steps)-1 else "service")
                icon = "🏁 " if s_idx == 0 else ("🛑 " if s_idx == len(steps)-1 else "⚙️ ")
                file_name = Path(st.get("filePath", "")).name
                mmd_lines.append(f"        {st_id}[\"{icon}{st['name']}<br/><small>{file_name}</small>\"]:::{cls}")
                if s_idx > 0:
                    prev_id = f"{wf_safe_id}_S{s_idx-1}"
                    mmd_lines.append(f"        {prev_id} --> {st_id}")
        mmd_lines.append("    end")
        mmd_lines.append("")

    mmd_content = "\n".join(mmd_lines)
    with open(output_mmd_path, "w", encoding="utf-8") as f:
        f.write(mmd_content)

    return mmd_content

# ============================================================================
# STAGE 3: workflow.mmd ──► workflow.svg
# ============================================================================

def convert_mmd_to_svg(workflow_mmd_path: Path, output_svg_path: Path) -> str:
    """Stage 3: Parse workflow.mmd content and render crisp standalone SVG diagram."""
    with open(workflow_mmd_path, "r", encoding="utf-8") as f:
        mmd_text = f.read()

    # Parse subgraphs and nodes directly from Mermaid source
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
            # Parse nodes: WF_1_S0["..."]:::ingress
            node_match = re.search(r'(\w+)\["(.+?)"\](?::::(\w+))?', line)
            if node_match:
                n_id = node_match.group(1)
                raw_label = node_match.group(2)
                cls = node_match.group(3) or "service"

                # Extract title and subtitle (<br/><small>filename</small>)
                parts = raw_label.split("<br/><small>")
                name = parts[0].replace("🏁 ", "").replace("🛑 ", "").replace("⚙️ ", "")
                sub = parts[1].replace("</small>", "") if len(parts) > 1 else ""

                current_subgraph["nodes"].append({
                    "id": n_id,
                    "name": name,
                    "sub": sub,
                    "class": cls
                })
            # Parse edges: S0 --> S1
            edge_match = re.search(r'(\w+)\s+-->\s+(\w+)', line)
            if edge_match:
                current_subgraph["edges"].append((edge_match.group(1), edge_match.group(2)))

    # Render SVG Vector Layout
    svg_height = max(400, len(subgraphs) * 160 + 100)
    svg_width = 900

    svg = [
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {svg_width} {svg_height}" width="{svg_width}" height="{svg_height}">',
        '  <defs>',
        '    <linearGradient id="bgGrad" x1="0%" y1="0%" x2="100%" y2="100%">',
        '      <stop offset="0%" stop-color="#0f172a"/>',
        '      <stop offset="100%" stop-color="#1e293b"/>',
        '    </linearGradient>',
        '    <marker id="arrow" viewBox="0 0 10 10" refX="6" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">',
        '      <path d="M 0 1 L 10 5 L 0 9 z" fill="#38bdf8"/>',
        '    </marker>',
        '  </defs>',
        f'  <rect width="{svg_width}" height="{svg_height}" fill="url(#bgGrad)"/>',
        f'  <text x="30" y="45" fill="#38bdf8" font-family="system-ui, -apple-system, sans-serif" font-size="20" font-weight="bold">⚡ LSP-Link Workflow Diagram (Rendered from workflow.mmd)</text>',
        f'  <text x="30" y="70" fill="#94a3b8" font-family="system-ui, -apple-system, sans-serif" font-size="12">Source: {html.escape(workflow_mmd_path.name)} | Total Workflows: {len(subgraphs)}</text>',
    ]

    y_offset = 110
    for idx, sg in enumerate(subgraphs, 1):
        svg.append(f'  <!-- {sg["id"]} -->')
        svg.append(f'  <g transform="translate(30, {y_offset})">')
        svg.append(f'    <rect width="840" height="130" rx="8" fill="#1e293b" stroke="#334155" stroke-width="1.5"/>')
        svg.append(f'    <text x="20" y="28" fill="#f59e0b" font-family="system-ui, sans-serif" font-size="14" font-weight="bold">{html.escape(sg["title"])}</text>')

        nodes_list = sg["nodes"]
        num_nodes = len(nodes_list)
        if num_nodes > 0:
            step_width = min(220, (760 - (num_nodes - 1) * 40) // max(1, num_nodes))
            for s_idx, nd in enumerate(nodes_list):
                x_pos = 20 + s_idx * (step_width + 40)
                cls = nd["class"]

                fill_col = "#065f46" if cls == "ingress" else ("#7f1d1d" if cls == "egress" else "#0f172a")
                border_col = "#10b981" if cls == "ingress" else ("#ef4444" if cls == "egress" else "#38bdf8")
                badge_txt = "INGRESS" if cls == "ingress" else ("EGRESS" if cls == "egress" else f"STEP {s_idx+1}")

                svg.append(f'    <rect x="{x_pos}" y="45" width="{step_width}" height="65" rx="6" fill="{fill_col}" stroke="{border_col}" stroke-width="1.5"/>')
                svg.append(f'    <rect x="{x_pos+8}" y="52" width="55" height="14" rx="3" fill="{border_col}" fill-opacity="0.2"/>')
                svg.append(f'    <text x="{x_pos+12}" y="63" fill="{border_col}" font-family="system-ui, sans-serif" font-size="9" font-weight="bold">{badge_txt}</text>')
                
                safe_name = html.escape(nd["name"])
                if len(safe_name) > 22:
                    safe_name = safe_name[:20] + "…"
                svg.append(f'    <text x="{x_pos+8}" y="84" fill="#f8fafc" font-family="system-ui, sans-serif" font-size="12" font-weight="600">{safe_name}</text>')
                
                safe_sub = html.escape(nd["sub"])
                if len(safe_sub) > 25:
                    safe_sub = safe_sub[:23] + "…"
                svg.append(f'    <text x="{x_pos+8}" y="100" fill="#94a3b8" font-family="system-ui, sans-serif" font-size="10">{safe_sub}</text>')

                if s_idx < num_nodes - 1:
                    arrow_start = x_pos + step_width
                    arrow_end = arrow_start + 35
                    svg.append(f'    <line x1="{arrow_start}" y1="78" x2="{arrow_end}" y2="78" stroke="#38bdf8" stroke-width="2" marker-end="url(#arrow)"/>')

        svg.append('  </g>')
        y_offset += 150

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
    print("🔄 SEQUENTIAL 3-STAGE WORKFLOW PIPELINE")
    print(f"   Target:  {proj_path}")
    print(f"   Outputs: {out_path}")
    print("==================================================")

    # Stage 1: Graph -> workflow.json
    print("⚙️  [1/3] Extracting flows ──► workflow.json...")
    extract_workflow_json(proj_path, json_file)
    print(f"   ✓ {json_file.name} ({json_file.stat().st_size} bytes)")

    # Stage 2: workflow.json -> workflow.mmd
    print("📊 [2/3] Converting workflow.json ──► workflow.mmd...")
    convert_json_to_mmd(json_file, mmd_file)
    print(f"   ✓ {mmd_file.name} ({mmd_file.stat().st_size} bytes)")

    # Stage 3: workflow.mmd -> workflow.svg
    print("🖼️  [3/3] Converting workflow.mmd ──► workflow.svg...")
    convert_mmd_to_svg(mmd_file, svg_file)
    print(f"   ✓ {svg_file.name} ({svg_file.stat().st_size} bytes)")

    print("==================================================")
    print("✅ 3-Stage Workflow Transformation Completed!")
    print("==================================================")

if __name__ == "__main__":
    target = sys.argv[1] if len(sys.argv) > 1 else "sample_projects/spring-boot-demo"
    out = sys.argv[2] if len(sys.argv) > 2 else None
    run_workflow_pipeline(target, out)
