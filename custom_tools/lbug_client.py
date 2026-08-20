#!/usr/bin/env python3
"""
Python Client for LadybugDB (.gitnexus/lbug).

Provides a typed Python interface to read and query the GitNexus Knowledge Graph,
instantiating strongly-typed dataclasses mimicking the TypeScript data structures.
"""

import os
import sys
from pathlib import Path
from typing import List, Dict, Any, Optional, Tuple
import ladybug

from models import (
    BaseNode,
    ClassNode,
    InterfaceNode,
    MethodNode,
    FunctionNode,
    RouteNode,
    ProcessNode,
    CommunityNode,
    FileNode,
    FolderNode,
    CodeRelation,
    ProcessStep,
)

class LadybugClient:
    """Python Client to read and query LadybugDB graphs with typed dataclasses."""

    def __init__(self, project_path: str):
        self.project_path = Path(project_path).resolve()
        self.db_path = self.project_path / ".gitnexus" / "lbug"

        if not self.db_path.exists():
            raise FileNotFoundError(
                f"LadybugDB not found at '{self.db_path}'. Run 'npm run analyze -- {project_path}' first."
            )

        self.db = ladybug.Database(str(self.db_path), read_only=True)
        self.conn = ladybug.Connection(self.db)

    def query(self, cypher_query: str) -> List[List[Any]]:
        """Execute a raw Cypher query and return rows as python lists."""
        result = self.conn.execute(cypher_query)
        rows = []
        while result.has_next():
            rows.append(result.get_next())
        return rows

    def get_classes(self) -> List[ClassNode]:
        """Fetch all Class nodes as ClassNode dataclasses."""
        rows = self.query("MATCH (c:Class) RETURN c.id, c.name, c.filePath, c.namespace, c.startLine, c.endLine;")
        return [
            ClassNode(
                id=r[0],
                name=r[1],
                file_path=r[2] or "",
                namespace=r[3] or "",
                start_line=int(r[4] or 1),
                end_line=int(r[5] or 1),
            )
            for r in rows
        ]

    def get_interfaces(self) -> List[InterfaceNode]:
        """Fetch all Interface nodes as InterfaceNode dataclasses."""
        rows = self.query("MATCH (i:Interface) RETURN i.id, i.name, i.filePath, i.namespace, i.startLine, i.endLine;")
        return [
            InterfaceNode(
                id=r[0],
                name=r[1],
                file_path=r[2] or "",
                namespace=r[3] or "",
                start_line=int(r[4] or 1),
                end_line=int(r[5] or 1),
            )
            for r in rows
        ]

    def get_methods(self) -> List[MethodNode]:
        """Fetch all Method nodes as MethodNode dataclasses."""
        rows = self.query("MATCH (m:Method) RETURN m.id, m.name, m.filePath, m.signature, m.startLine, m.endLine;")
        return [
            MethodNode(
                id=r[0],
                name=r[1],
                file_path=r[2] or "",
                signature=r[3] or "",
                start_line=int(r[4] or 1),
                end_line=int(r[5] or 1),
            )
            for r in rows
        ]

    def get_routes(self) -> List[RouteNode]:
        """Fetch all Route nodes (Ingress) as RouteNode dataclasses."""
        rows = self.query("MATCH (r:Route) RETURN r.id, r.name, r.method, r.filePath, r.handlerSymbolId, r.startLine, r.endLine;")
        return [
            RouteNode(
                id=r[0],
                name=r[1],
                method=r[2] or "GET",
                file_path=r[3] or "",
                handler_symbol_id=r[4] or "",
                start_line=int(r[5] or 1),
                end_line=int(r[6] or 1),
            )
            for r in rows
        ]

    def get_processes(self) -> List[ProcessNode]:
        """Fetch all Process execution flows as ProcessNode dataclasses."""
        rows = self.query("MATCH (p:Process) RETURN p.id, p.label, p.entryPointId, p.terminalId, p.stepCount;")
        return [
            ProcessNode(
                id=r[0],
                label=r[1],
                entry_point_id=r[2],
                terminal_id=r[3],
                step_count=int(r[4] or 1),
            )
            for r in rows
        ]

    def get_communities(self) -> List[CommunityNode]:
        """Fetch all Community clusters as CommunityNode dataclasses."""
        rows = self.query("MATCH (c:Community) RETURN c.id, c.name, c.size;")
        return [
            CommunityNode(
                id=r[0],
                label=r[1],
                size=int(r[2] or 1),
            )
            for r in rows
        ]

    def get_relations(self, rel_type: Optional[str] = None) -> List[CodeRelation]:
        """Fetch relationship edges as CodeRelation dataclasses."""
        if rel_type:
            q = f"MATCH (a)-[r:CodeRelation {{type: '{rel_type}'}}]->(b) RETURN a.id, b.id, r.type, r.confidence, r.reason, r.step;"
        else:
            q = "MATCH (a)-[r:CodeRelation]->(b) RETURN a.id, b.id, r.type, r.confidence, r.reason, r.step;"
        rows = self.query(q)
        return [
            CodeRelation(
                source_id=r[0],
                target_id=r[1],
                type=r[2],
                confidence=float(r[3] or 1.0),
                reason=r[4] or "",
                step=int(r[5] or 0),
            )
            for r in rows
        ]

    def get_outgoing_calls(self, method_id: str) -> List[Tuple[str, str, float]]:
        """Get all methods called by method_id."""
        q = f"MATCH (a:Method {{id: '{method_id}'}})-[r:CodeRelation {{type: 'CALLS'}}]->(b:Method) RETURN b.id, b.name, r.confidence;"
        return [(r[0], r[1], float(r[2] or 1.0)) for r in self.query(q)]

    def get_incoming_calls(self, method_id: str) -> List[Tuple[str, str, float]]:
        """Get all methods that call method_id."""
        q = f"MATCH (a:Method)-[r:CodeRelation {{type: 'CALLS'}}]->(b:Method {{id: '{method_id}'}}) RETURN a.id, a.name, r.confidence;"
        return [(r[0], r[1], float(r[2] or 1.0)) for r in self.query(q)]

    def get_process_steps(self, process_id: str) -> List[ProcessStep]:
        """Get all chronological steps for a given Process flow."""
        q = f"""
        MATCH (m:Method)-[r:CodeRelation {{type: 'STEP_IN_PROCESS'}}]->(p:Process {{id: '{process_id}'}})
        RETURN r.step, m.id, m.name, m.filePath
        ORDER BY r.step;
        """
        rows = self.query(q)
        return [
            ProcessStep(
                step_number=int(r[0]),
                node_id=r[1],
                node_name=r[2],
                file_path=r[3] or "",
            )
            for r in rows
        ]

def main():
    target = sys.argv[1] if len(sys.argv) > 1 else "sample_projects/spring-boot-demo"
    client = LadybugClient(target)

    print("==================================================")
    print("🐍 PYTHON LADYBUGDB CLIENT & TYPED DATA CLASSES")
    print(f"   Target: {client.project_path}")
    print("==================================================")

    classes = client.get_classes()
    methods = client.get_methods()
    routes = client.get_routes()
    processes = client.get_processes()
    calls = client.get_relations(rel_type="CALLS")

    print(f"\n📦 Loaded Data Classes from .gitnexus/lbug:")
    print(f"   • ClassNode count:     {len(classes)}")
    print(f"   • MethodNode count:    {len(methods)}")
    print(f"   • RouteNode count:     {len(routes)}")
    print(f"   • ProcessNode count:   {len(processes)}")
    print(f"   • CALLS edges:         {len(calls)}")

    if routes:
        print("\n🚪 Sample Ingress Routes (RouteNode):")
        for r in routes[:3]:
            print(f"   [RouteNode] {r.method} {r.name} -> Handler: {r.handler_symbol_id} ({r.file_path})")

    if processes:
        print("\n⚡ Sample Business Process (ProcessNode):")
        p = processes[0]
        print(f"   [ProcessNode] ID: {p.id} | Steps: {p.step_count} | Label: {p.label}")
        steps = client.get_process_steps(p.id)
        for st in steps:
            print(f"      Step {st.step_number}: {st.node_name} ({st.file_path})")

    print("\n==================================================")
    print("✅ Python Ladybug Client Read Test Passed!")
    print("==================================================")

if __name__ == "__main__":
    main()
