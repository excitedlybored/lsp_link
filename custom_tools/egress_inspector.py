#!/usr/bin/env python3
"""
Egress Sink Inspector: Detailed Analysis of all Outbound Integration Points.

Inspects all external database, HTTP client, and message producer sinks in LadybugDB,
displaying:
1. Egress Sink Symbol & Method Name
2. Technology / Protocol Category (REST HTTP, JPA DB, Kafka MQ, Temporal RPC)
3. Declaration File & Line Numbers
4. Inbound Callers & Originating Ingress Routes
"""

import sys
import os
import json
from pathlib import Path
from typing import List, Dict, Any
from tabulate import tabulate

try:
    from custom_tools.lbug_client import LadybugClient
except ImportError:
    from lbug_client import LadybugClient

def inspect_egress_sinks(project_dir: str):
    proj_path = Path(project_dir).resolve()
    gitnexus_dir = proj_path / ".gitnexus"
    wf_path = gitnexus_dir / "workflow.json"

    if not wf_path.exists():
        print(f"❌ Error: workflow.json not found in '{gitnexus_dir}'. Run 'npm run workflow:export -- {project_dir}' first.")
        sys.exit(1)

    with open(wf_path, "r", encoding="utf-8") as f:
        wf_data = json.load(f)

    egress_points = wf_data.get("egressPoints", [])
    flows = wf_data.get("ingressToEgressFlows", [])
    client = LadybugClient(str(proj_path))

    print("\n" + "=" * 80)
    print("🛑 EGRESS SINK & OUTBOUND BOUNDARY INSPECTOR")
    print(f"   Target Repository: {proj_path}")
    print(f"   Total Detected Egress Sinks: {len(egress_points)}")
    print("=" * 80 + "\n")

    table_data = []
    for idx, ep in enumerate(egress_points, 1):
        name = ep["name"]
        f_path = ep.get("filePath", "")
        p_lower = f_path.lower()
        
        # Categorize technology
        if "http" in p_lower or "client" in p_lower or "swift" in p_lower or "clearing" in p_lower:
            category = "🌐 Outbound HTTP / REST Client"
        elif "repo" in p_lower or "db" in p_lower or "store" in p_lower or "ledger" in p_lower:
            category = "🗄️ Database / JPA / ORM"
        elif "producer" in p_lower or "kafka" in p_lower or "mq" in p_lower:
            category = "📬 Message Queue / Kafka Producer"
        elif "activity" in p_lower:
            category = "⚡ Temporal Activity / RPC Sink"
        else:
            category = "🛑 Outbound Integration Sink"

        # Find direct callers
        incoming = client.get_incoming_calls(ep["id"])
        callers = list({c[1] for c in incoming})
        caller_str = ", ".join(callers) if callers else "(Direct Ingress)"

        # Find connected Ingress origins from flows
        origins = list({f["ingress"] for f in flows if f.get("egressId") == ep["id"]})
        origin_str = ", ".join(origins) if origins else "(Internal Domain)"

        table_data.append([
            idx,
            name,
            category,
            f_path,
            caller_str,
            origin_str
        ])

    headers = ["#", "Egress Sink", "Category", "Source File", "Direct Callers", "Originating Ingress"]
    print(tabulate(table_data, headers=headers, tablefmt="github"))
    print("\n" + "=" * 80 + "\n")

if __name__ == "__main__":
    target = sys.argv[1] if len(sys.argv) > 1 else "examples/01_spring_boot_banking"
    inspect_egress_sinks(target)
