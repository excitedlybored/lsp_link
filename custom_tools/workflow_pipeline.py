#!/usr/bin/env python3
"""
Workflow Pipeline: Exports workflow.json, workflow.mmd, and workflow.svg.

Reads compiler-verified execution flows from LadybugDB (.gitnexus/lbug) or graph.json
and generates:
1. `workflow.json` - Structured execution flow manifest
2. `workflow.mmd`  - Mermaid sequence and flowchart diagram
3. `workflow.svg`  - Crisp standalone vector SVG diagram
"""

import sys
import os
import json
import html
from pathlib import Path
from typing import List, Dict, Any

def generate_workflow_artifacts(project_dir: str, output_dir: str = None):
    proj_path = Path(project_dir).resolve()
    gitnexus_dir = proj_path / ".gitnexus"
    
    if output_dir:
        out_path = Path(output_dir).resolve()
    else:
        out_path = gitnexus_dir

    out_path.mkdir(parents=True, exist_ok=True)

    graph_file = gitnexus_dir / "graph.json"
    if not graph_file.exists():
        print(f"❌ Error: graph.json not found in '{gitnexus_dir}'. Run 'npm run analyze -- {project_dir}' first.")
        sys.exit(1)

    with open(graph_file, "r", encoding="utf-8") as f:
        graph_data = json.load(f)

    nodes = {n["id"]: n for n in graph_data.get("nodes", [])}
    relationships = graph_data.get("relationships", [])

    # Find Process nodes
    process_nodes = [n for n in nodes.values() if n.get("label") == "Process"]
    routes = [n for n in nodes.values() if n.get("label") == "Route"]

    # 1. Build workflow.json structure
    workflows = []
    for idx, p in enumerate(process_nodes, 1):
        p_id = p["id"]
        props = p.get("properties", {})
        label = props.get("label", f"Workflow {idx}")
        ep_id = props.get("entryPointId", "")
        term_id = props.get("terminalId", "")

        # Find steps for this process
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

    workflow_json_path = out_path / "workflow.json"
    with open(workflow_json_path, "w", encoding="utf-8") as f:
        json.dump({
            "project": str(proj_path),
            "totalWorkflows": len(workflows),
            "workflows": workflows
        }, f, indent=2)

    # 2. Build workflow.mmd (Mermaid Diagram)
    mmd_lines = [
        "%%{init: {'theme': 'dark', 'themeVariables': { 'darkMode': true, 'primaryColor': '#1e293b', 'edgeLabelBackground':'#0f172a'}}}%%",
        "flowchart TD",
        "    classDef ingress fill:#065f46,stroke:#10b981,stroke-width:2px,color:#ecfdf5;",
        "    classDef service fill:#1e293b,stroke:#38bdf8,stroke-width:2px,color:#f0f9ff;",
        "    classDef egress fill:#7f1d1d,stroke:#ef4444,stroke-width:2px,color:#fef2f2;",
        "    classDef flow fill:#78350f,stroke:#f59e0b,stroke-width:2px,color:#fffbeb;",
        ""
    ]

    for w_idx, wf in enumerate(workflows, 1):
        wf_safe_id = f"WF_{w_idx}"
        mmd_lines.append(f"    subgraph {wf_safe_id} [\"⚡ {wf['label']}\"]")
        steps = wf["steps"]
        if not steps:
            ep_name = wf["entryPoint"]["name"]
            term_name = wf["terminalSink"]["name"]
            mmd_lines.append(f"        {wf_safe_id}_EP[\"🏁 {ep_name}\"]:::ingress --> {wf_safe_id}_TERM[\"🛑 {term_name}\"]:::egress")
        else:
            for s_idx, st in enumerate(steps):
                st_id = f"{wf_safe_id}_S{s_idx}"
                cls = "ingress" if s_idx == 0 else ("egress" if s_idx == len(steps)-1 else "service")
                icon = "🏁 " if s_idx == 0 else ("🛑 " if s_idx == len(steps)-1 else "⚙️ ")
                mmd_lines.append(f"        {st_id}[\"{icon}{st['name']}<br/><small>{Path(st['filePath']).name}</small>\"]:::{cls}")
                if s_idx > 0:
                    prev_id = f"{wf_safe_id}_S{s_idx-1}"
                    mmd_lines.append(f"        {prev_id} --> {st_id}")
        mmd_lines.append("    end")
        mmd_lines.append("")

    workflow_mmd_path = out_path / "workflow.mmd"
    with open(workflow_mmd_path, "w", encoding="utf-8") as f:
        f.write("\n".join(mmd_lines))

    # 3. Build workflow.svg (Pure Vector SVG Diagram)
    svg_height = max(400, len(workflows) * 160 + 100)
    svg_width = 900

    svg_elements = [
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
        f'  <text x="30" y="45" fill="#38bdf8" font-family="system-ui, -apple-system, sans-serif" font-size="20" font-weight="bold">⚡ LSP-Link Compiler-Verified Execution Workflows</text>',
        f'  <text x="30" y="70" fill="#94a3b8" font-family="system-ui, -apple-system, sans-serif" font-size="12">Generated for: {html.escape(str(proj_path))} | Total Flows: {len(workflows)}</text>',
    ]

    y_offset = 110
    for w_idx, wf in enumerate(workflows, 1):
        svg_elements.append(f'  <!-- Workflow {w_idx} -->')
        svg_elements.append(f'  <g transform="translate(30, {y_offset})">')
        svg_elements.append(f'    <rect width="840" height="130" rx="8" fill="#1e293b" stroke="#334155" stroke-width="1.5"/>')
        svg_elements.append(f'    <text x="20" y="28" fill="#f59e0b" font-family="system-ui, -apple-system, sans-serif" font-size="14" font-weight="bold">⚡ Flow #{w_idx}: {html.escape(wf["label"])}</text>')

        steps = wf["steps"]
        if steps:
            num_steps = len(steps)
            step_width = min(220, (760 - (num_steps - 1) * 40) // max(1, num_steps))
            
            for s_idx, st in enumerate(steps):
                x_pos = 20 + s_idx * (step_width + 40)
                is_first = (s_idx == 0)
                is_last = (s_idx == num_steps - 1)
                
                fill_col = "#065f46" if is_first else ("#7f1d1d" if is_last else "#0f172a")
                border_col = "#10b981" if is_first else ("#ef4444" if is_last else "#38bdf8")
                badge_txt = "INGRESS" if is_first else ("EGRESS" if is_last else f"STEP {s_idx+1}")

                svg_elements.append(f'    <!-- Step {s_idx} -->')
                svg_elements.append(f'    <rect x="{x_pos}" y="45" width="{step_width}" height="65" rx="6" fill="{fill_col}" stroke="{border_col}" stroke-width="1.5"/>')
                svg_elements.append(f'    <rect x="{x_pos+8}" y="52" width="55" height="14" rx="3" fill="{border_col}" fill-opacity="0.2"/>')
                svg_elements.append(f'    <text x="{x_pos+12}" y="63" fill="{border_col}" font-family="system-ui, sans-serif" font-size="9" font-weight="bold">{badge_txt}</text>')
                
                safe_name = html.escape(st["name"])
                if len(safe_name) > 22:
                    safe_name = safe_name[:20] + "…"
                svg_elements.append(f'    <text x="{x_pos+8}" y="84" fill="#f8fafc" font-family="system-ui, sans-serif" font-size="12" font-weight="600">{safe_name}</text>')
                
                file_basename = html.escape(Path(st["filePath"]).name)
                if len(file_basename) > 25:
                    file_basename = file_basename[:23] + "…"
                svg_elements.append(f'    <text x="{x_pos+8}" y="100" fill="#94a3b8" font-family="system-ui, sans-serif" font-size="10">{file_basename}</text>')

                # Arrow connecting to next step
                if s_idx < num_steps - 1:
                    arrow_start = x_pos + step_width
                    arrow_end = arrow_start + 35
                    svg_elements.append(f'    <line x1="{arrow_start}" y1="78" x2="{arrow_end}" y2="78" stroke="#38bdf8" stroke-width="2" marker-end="url(#arrow)"/>')

        svg_elements.append('  </g>')
        y_offset += 150

    svg_elements.append('</svg>')

    workflow_svg_path = out_path / "workflow.svg"
    with open(workflow_svg_path, "w", encoding="utf-8") as f:
        f.write("\n".join(svg_elements))

    print("==================================================")
    print("⚡ WORKFLOW PIPELINE EXPORT COMPLETE")
    print(f"   Target:  {proj_path}")
    print(f"   Outputs: {out_path}")
    print("==================================================")
    print(f"   📄 1. {workflow_json_path.name}  ({workflow_json_path.stat().st_size} bytes)")
    print(f"   📊 2. {workflow_mmd_path.name}   ({workflow_mmd_path.stat().st_size} bytes)")
    print(f"   🖼️  3. {workflow_svg_path.name}   ({workflow_svg_path.stat().st_size} bytes)")
    print("==================================================")

if __name__ == "__main__":
    target = sys.argv[1] if len(sys.argv) > 1 else "sample_projects/spring-boot-demo"
    out = sys.argv[2] if len(sys.argv) > 2 else None
    generate_workflow_artifacts(target, out)
