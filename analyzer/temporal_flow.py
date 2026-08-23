#!/usr/bin/env python3
"""
Statically Inferred Temporal Flow Visualizer.

Reads Temporal workflow source directly from LadybugDB (.gitnexus/lbug) plus
a targeted Tree-sitter walk of each Orchestrator's source, and renders a
Layer 2/3 "Conditional Transaction Flow" diagram:

  Layer 1 (Primitive Recognition) - PrimitiveExtractor
    Classifies Interface/Method nodes as Temporal Workflow/Activity contracts
    using the same `sdk_registry.json` signatures already tracked for
    generic Ingress/Egress detection (`temporal_workflow_interface`,
    `temporal_workflow_entry`, `temporal_signal_ingress`, `temporal_query_ingress`,
    `temporal_update_ingress`, `temporal_activity_interface`).

  Layer 2 (Control Flow Extraction) - MethodBodyWalker
    Walks each Orchestrator entry method's real body (Tree-sitter Java) to
    tag every call site with its enclosing if/catch/loop context, detect
    Saga compensation triggers, stateful pauses (Workflow.await/sleep), and
    Temporal's untyped/dynamic activity dispatch (Workflow.newUntypedActivityStub
    + ActivityStub.execute(<runtime string>, ...)), which lbug's own CALLS
    edges do not resolve (no static call target) and would otherwise be
    silently dropped.

  Layer 3 (Architectural Boundary Mapping) - BoundaryMapper
    Buckets each call site into Ingress / Orchestrator / Activity /
    Child Workflow roles, labels Orchestrator->Activity/ChildWorkflow edges
    with their Task Queue, and flags determinism violations (raw I/O
    egress called directly from an Orchestrator instead of via an Activity
    stub).

V1 targets Java (matches the registry's existing Temporal depth and both
local test fixtures). `sdk_registry.json` entries carry a `language` field,
so TypeScript/Python Temporal SDK patterns are a data addition, not a code
change, when needed.

Usage:
  uv run python analyzer/temporal_flow.py <project_dir> [--output-dir DIR]
"""

import argparse
import html
import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import ladybug
import tree_sitter
import tree_sitter_java

REGISTRY_PATH = Path(__file__).parent / "sdk_registry.json"
MAX_RECURSE_DEPTH = 3

JAVA_LANGUAGE = tree_sitter.Language(tree_sitter_java.language())
JAVA_PARSER = tree_sitter.Parser(JAVA_LANGUAGE)

SAGA_TRIGGER_RE = re.compile(r"compensat|rollback|undo", re.IGNORECASE)
# Reused from workflow_pipeline.classify_role's generic I/O heuristic, applied
# to a call site's *declared field/local type name* (not the method name) to
# flag raw I/O invoked directly from an Orchestrator body (determinism check).
GENERIC_EGRESS_TYPE_RE = re.compile(r"repository|client|template|producer|gateway", re.IGNORECASE)

# A resolved field/local declaration: (kind, target_type). `kind` is one of
# 'activity_stub' | 'child_workflow_stub' | 'untyped_activity_stub' | 'helper'.
DeclaredKind = Tuple[str, str]
KindMap = Dict[str, DeclaredKind]


# ============================================================================
# Data Models — mirror gitnexus_ts_isolated/src/lbug/schema.ts node tables
# ============================================================================

@dataclass(frozen=True)
class InterfaceNode:
    """Mirrors INTERFACE_SCHEMA."""
    id: str
    name: str
    filePath: str = ""
    startLine: int = 1
    endLine: int = 1
    isExported: bool = True
    content: str = ""
    description: str = ""


@dataclass(frozen=True)
class ClassNode:
    """Mirrors CLASS_SCHEMA."""
    id: str
    name: str
    filePath: str = ""
    startLine: int = 1
    endLine: int = 1
    isExported: bool = True
    content: str = ""
    description: str = ""
    frameworkAnnotations: List[str] = field(default_factory=list)


@dataclass(frozen=True)
class MethodNode:
    """Mirrors METHOD_SCHEMA."""
    id: str
    name: str
    filePath: str = ""
    startLine: int = 1
    endLine: int = 1
    isExported: bool = True
    content: str = ""
    description: str = ""
    parameterCount: int = 0
    returnType: str = ""


@dataclass
class CallSite:
    """One resolved call site discovered while walking a method body (Layer 2)."""
    object_name: Optional[str]
    method_name: str
    context: Optional[str]
    saga_compensation: bool
    kind: str  # 'activity' | 'dynamic_activity' | 'child_workflow' | 'pause' | 'helper' | 'internal'
    resolved_name: str
    line: int
    depth: int = 0


# ============================================================================
# SDK Registry — Temporal signature lookup
# ============================================================================

def load_sdk_registry() -> Dict[str, Any]:
    with open(REGISTRY_PATH, "r", encoding="utf-8") as f:
        return json.load(f)


def _registry_annotation_name(entries: List[Dict[str, str]], entry_id: str) -> Optional[str]:
    """Derives the bare annotation name (e.g. 'WorkflowMethod') from a registry entry's
    fully-qualified import pattern (e.g. `\\bio\\.temporal\\.workflow\\.WorkflowMethod\\b`),
    since annotations appear at their use site by simple name, not the qualified path."""
    for e in entries:
        if e["id"] == entry_id:
            # Strip \b word-boundary anchors first — they'd otherwise be
            # picked up as a bogus trailing "b" identifier token.
            stripped = e["pattern"].replace("\\b", "")
            tokens = re.findall(r"[A-Za-z_][A-Za-z0-9_]*", stripped)
            return tokens[-1] if tokens else None
    return None


class TemporalSignatures:
    """Temporal annotation names + generic egress regexes, derived from `sdk_registry.json`."""

    def __init__(self, registry: Dict[str, Any]):
        ingress, egress = registry.get("ingress", []), registry.get("egress", [])
        self.workflow_interface = _registry_annotation_name(ingress, "temporal_workflow_interface")
        self.workflow_entry = _registry_annotation_name(ingress, "temporal_workflow_entry")
        self.signal_ingress = _registry_annotation_name(ingress, "temporal_signal_ingress")
        self.query_ingress = _registry_annotation_name(ingress, "temporal_query_ingress")
        self.update_ingress = _registry_annotation_name(ingress, "temporal_update_ingress")
        self.activity_interface = _registry_annotation_name(egress, "temporal_activity_interface")
        # Generic (non-Temporal) I/O egress patterns, for the determinism-violation check
        # (matched against a *declared field/local type name*, not an annotation).
        self.generic_egress = [
            re.compile(e["pattern"])
            for e in egress
            if not e["id"].startswith("temporal_")
        ]


# ============================================================================
# Tree-sitter source access
# ============================================================================

def find_all_nodes(root: tree_sitter.Node, node_type: str) -> List[tree_sitter.Node]:
    """Collects every descendant of `root` (inclusive) matching `node_type`."""
    out: List[tree_sitter.Node] = []

    def walk(n: tree_sitter.Node) -> None:
        if n.type == node_type:
            out.append(n)
        for c in n.named_children:
            walk(c)

    walk(root)
    return out


class SourceCache:
    """Reads and parses each Java source file at most once."""

    def __init__(self, project_root: Path):
        self.project_root = project_root
        self._lines: Dict[str, List[str]] = {}
        self._bytes: Dict[str, bytes] = {}
        self._tree: Dict[str, tree_sitter.Tree] = {}

    def _abs(self, file_path: str) -> Path:
        return self.project_root / file_path

    def _load(self, file_path: str) -> None:
        if file_path in self._bytes:
            return
        try:
            raw = self._abs(file_path).read_bytes()
        except (FileNotFoundError, OSError):
            raw = b""
        self._bytes[file_path] = raw
        self._lines[file_path] = raw.decode("utf-8", errors="ignore").splitlines()

    def tree_for(self, file_path: str) -> tree_sitter.Tree:
        if file_path not in self._tree:
            self._load(file_path)
            self._tree[file_path] = JAVA_PARSER.parse(self._bytes[file_path])
        return self._tree[file_path]

    def node_text(self, file_path: str, node: tree_sitter.Node) -> str:
        self._load(file_path)
        return self._bytes[file_path][node.start_byte:node.end_byte].decode("utf-8", errors="ignore")

    def find_type_declaration(self, file_path: str, type_name: str) -> Optional[tree_sitter.Node]:
        """Finds a class_declaration/interface_declaration node by simple name."""
        root = self.tree_for(file_path).root_node

        def walk(n: tree_sitter.Node) -> Optional[tree_sitter.Node]:
            if n.type in ("class_declaration", "interface_declaration"):
                name_node = n.child_by_field_name("name")
                if name_node and self.node_text(file_path, name_node) == type_name:
                    return n
            for c in n.named_children:
                r = walk(c)
                if r:
                    return r
            return None

        return walk(root)

    def find_method_declaration(self, file_path: str, type_name: str, method_name: str) -> Optional[tree_sitter.Node]:
        """Finds a method_declaration by name inside the given type, preferring the largest overload."""
        type_node = self.find_type_declaration(file_path, type_name)
        if not type_node:
            return None
        body = type_node.child_by_field_name("body")
        if not body:
            return None
        # Overloads: prefer whichever declaration has the largest body — a
        # thin delegating overload (e.g. `compensate()` -> `compensate(null, null)`)
        # is less useful to walk than the one carrying the real logic.
        candidates = [
            c for c in body.named_children
            if c.type == "method_declaration"
            and (name_node := c.child_by_field_name("name")) is not None
            and self.node_text(file_path, name_node) == method_name
        ]
        if not candidates:
            return None
        return max(candidates, key=lambda n: n.end_byte - n.start_byte)

    # -- annotations -----------------------------------------------------
    # Read straight off each declaration's own `modifiers` node rather than a
    # line-number window: a fixed-size text window can bleed a *neighboring*
    # method's annotation into the one being classified (seen in practice —
    # a Signal method a few lines below its Workflow method's @WorkflowMethod
    # was silently misclassified). The AST ties each annotation to its own
    # declaration exactly, so there's nothing to get wrong.

    @staticmethod
    def _modifiers_node(decl_node: tree_sitter.Node) -> Optional[tree_sitter.Node]:
        return next((c for c in decl_node.named_children if c.type == "modifiers"), None)

    def annotation_names(self, file_path: str, decl_node: tree_sitter.Node) -> set:
        """Simple names of every annotation on `decl_node` (e.g. {'Override', 'WorkflowMethod'})."""
        modifiers = self._modifiers_node(decl_node)
        if not modifiers:
            return set()
        names = set()
        for c in modifiers.named_children:
            if c.type in ("marker_annotation", "annotation"):
                name_node = c.child_by_field_name("name")
                if name_node:
                    names.add(self.node_text(file_path, name_node))
        return names

    def find_type_annotations(self, file_path: str, type_name: str) -> set:
        node = self.find_type_declaration(file_path, type_name)
        return self.annotation_names(file_path, node) if node else set()

    def find_method_annotations(self, file_path: str, type_name: str, method_name: str) -> set:
        node = self.find_method_declaration(file_path, type_name, method_name)
        return self.annotation_names(file_path, node) if node else set()

    def find_annotation_string_argument(self, file_path: str, type_name: str, annotation_name: str, arg_key: str) -> Optional[str]:
        """Extracts a string-literal annotation argument, e.g. `@WorkflowImpl(taskQueues = "q")`."""
        type_node = self.find_type_declaration(file_path, type_name)
        modifiers = self._modifiers_node(type_node) if type_node else None
        if not modifiers:
            return None
        for c in modifiers.named_children:
            if c.type != "annotation":
                continue
            name_node = c.child_by_field_name("name")
            if not name_node or self.node_text(file_path, name_node) != annotation_name:
                continue
            arguments = c.child_by_field_name("arguments")
            for pair in (arguments.named_children if arguments else []):
                if pair.type != "element_value_pair":
                    continue
                key_node = pair.child_by_field_name("key")
                value_node = pair.child_by_field_name("value")
                if not (key_node and value_node and self.node_text(file_path, key_node) == arg_key):
                    continue
                if value_node.type == "string_literal":
                    frag = next((g for g in value_node.named_children if g.type == "string_fragment"), None)
                    if frag:
                        return self.node_text(file_path, frag)
        return None


# ============================================================================
# LadybugDB access
# ============================================================================

class LadybugSource:
    """Typed read-only access to the project's `.gitnexus/lbug` knowledge graph."""

    _INTERFACE_COLUMNS = "id, name, filePath, startLine, endLine, isExported, content, description"
    _CLASS_COLUMNS = "id, name, filePath, startLine, endLine, isExported, content, description, frameworkAnnotations"
    _METHOD_COLUMNS = "id, name, filePath, startLine, endLine, isExported, content, description, parameterCount, returnType"

    def __init__(self, project_dir: Path):
        self.project_dir = project_dir
        db_path = project_dir / ".gitnexus" / "lbug"
        if not db_path.exists():
            raise FileNotFoundError(
                f"LadybugDB not found at '{db_path}'. Run 'npm run analyze -- {project_dir}' first."
            )
        self.db = ladybug.Database(str(db_path), read_only=True)
        self.conn = ladybug.Connection(self.db)

    def query(self, cypher: str) -> List[List[Any]]:
        res = self.conn.execute(cypher)
        rows = []
        while res.has_next():
            rows.append(res.get_next())
        return rows

    @staticmethod
    def _select_columns(alias: str, columns: str) -> str:
        return ", ".join(f"{alias}.{c.strip()}" for c in columns.split(","))

    @staticmethod
    def _row_to_interface(r: List[Any]) -> InterfaceNode:
        return InterfaceNode(
            id=r[0], name=r[1], filePath=r[2] or "", startLine=int(r[3] or 1), endLine=int(r[4] or 1),
            isExported=bool(r[5]), content=r[6] or "", description=r[7] or "",
        )

    @staticmethod
    def _row_to_class(r: List[Any]) -> ClassNode:
        return ClassNode(
            id=r[0], name=r[1], filePath=r[2] or "", startLine=int(r[3] or 1), endLine=int(r[4] or 1),
            isExported=bool(r[5]), content=r[6] or "", description=r[7] or "",
            frameworkAnnotations=list(r[8]) if r[8] else [],
        )

    @staticmethod
    def _row_to_method(r: List[Any]) -> MethodNode:
        return MethodNode(
            id=r[0], name=r[1], filePath=r[2] or "", startLine=int(r[3] or 1), endLine=int(r[4] or 1),
            isExported=bool(r[5]), content=r[6] or "", description=r[7] or "",
            parameterCount=int(r[8] or 0), returnType=r[9] or "",
        )

    def all_interfaces(self) -> List[InterfaceNode]:
        rows = self.query(f"MATCH (i:Interface) RETURN {self._select_columns('i', self._INTERFACE_COLUMNS)};")
        return [self._row_to_interface(r) for r in rows]

    def methods_declared_on(self, owner_id: str) -> List[MethodNode]:
        rows = self.query(
            f"MATCH (o {{id: '{owner_id}'}})-[r:CodeRelation]->(m:Method) WHERE r.type = 'HAS_METHOD' "
            f"RETURN {self._select_columns('m', self._METHOD_COLUMNS)};"
        )
        return [self._row_to_method(r) for r in rows]

    def classes_implementing(self, interface_id: str) -> List[ClassNode]:
        rows = self.query(
            f"MATCH (c:Class)-[r:CodeRelation]->(i {{id: '{interface_id}'}}) WHERE r.type = 'IMPLEMENTS' "
            f"RETURN {self._select_columns('c', self._CLASS_COLUMNS)};"
        )
        return [self._row_to_class(r) for r in rows]

    def find_class_by_name(self, name: str) -> Optional[ClassNode]:
        rows = self.query(
            f"MATCH (c:Class {{name: '{name}'}}) RETURN {self._select_columns('c', self._CLASS_COLUMNS)} LIMIT 1;"
        )
        return self._row_to_class(rows[0]) if rows else None

    def find_interface_by_name(self, name: str) -> Optional[InterfaceNode]:
        rows = self.query(
            f"MATCH (i:Interface {{name: '{name}'}}) RETURN {self._select_columns('i', self._INTERFACE_COLUMNS)} LIMIT 1;"
        )
        return self._row_to_interface(rows[0]) if rows else None


# ============================================================================
# Layer 1: Primitive Recognition
# ============================================================================

class PrimitiveExtractor:
    """Classifies Interface/Method nodes into Temporal roles using their AST annotations."""

    def __init__(self, graph: LadybugSource, source: SourceCache, signatures: TemporalSignatures):
        self.graph = graph
        self.source = source
        self.signatures = signatures
        self.workflow_interfaces: Dict[str, InterfaceNode] = {}
        self.activity_interfaces: Dict[str, InterfaceNode] = {}
        # interface_id -> {method_name: role}
        self.method_roles: Dict[str, Dict[str, str]] = {}

    def classify_all(self) -> None:
        for iface in self.graph.all_interfaces():
            annotations = self.source.find_type_annotations(iface.filePath, iface.name)
            if self.signatures.workflow_interface in annotations:
                self.workflow_interfaces[iface.id] = iface
                self._classify_workflow_methods(iface)
            elif self.signatures.activity_interface in annotations:
                self.activity_interfaces[iface.id] = iface
                # All methods on an @ActivityInterface are Activities by default;
                # @ActivityMethod on individual methods only renames the activity type.
                self.method_roles[iface.id] = {
                    m.name: "activity" for m in self.graph.methods_declared_on(iface.id)
                }

    def _classify_workflow_methods(self, iface: InterfaceNode) -> None:
        roles: Dict[str, str] = {}
        sig = self.signatures
        for m in self.graph.methods_declared_on(iface.id):
            annotations = self.source.find_method_annotations(m.filePath, iface.name, m.name)
            if sig.workflow_entry in annotations:
                roles[m.name] = "entry"
            elif sig.signal_ingress in annotations:
                roles[m.name] = "signal"
            elif sig.query_ingress in annotations:
                roles[m.name] = "query"
            elif sig.update_ingress in annotations:
                roles[m.name] = "update"
        self.method_roles[iface.id] = roles

    def implementation_of(self, interface_id: str) -> Optional[ClassNode]:
        impls = self.graph.classes_implementing(interface_id)
        return impls[0] if impls else None

    def task_queue_of(self, impl_class: ClassNode) -> Optional[str]:
        return self.source.find_annotation_string_argument(impl_class.filePath, impl_class.name, "WorkflowImpl", "taskQueues")


# ============================================================================
# Layer 2: Control Flow Extraction
# ============================================================================

class MethodBodyWalker:
    """Resolves field/local variable kinds for a class and walks a method body for call sites."""

    def __init__(self, source: SourceCache, extractor: PrimitiveExtractor, graph: LadybugSource):
        self.source = source
        self.extractor = extractor
        self.graph = graph
        self._activity_iface_names = {i.name for i in extractor.activity_interfaces.values()}
        self._workflow_iface_names = {i.name for i in extractor.workflow_interfaces.values()}

    # -- field/local kind resolution -----------------------------------

    def _classify_declaration(self, type_name: str, init_text: str) -> Optional[DeclaredKind]:
        """Returns (kind, target_type) for a field/local declaration, if recognized."""
        type_name = type_name.split(".")[-1] if type_name else type_name
        if "newUntypedActivityStub" in init_text:
            return ("untyped_activity_stub", type_name)
        m = re.search(r"newActivityStub\(\s*([\w.]+)\.class", init_text)
        if m:
            return ("activity_stub", m.group(1).split(".")[-1])
        m = re.search(r"newChildWorkflowStub\(\s*([\w.]+)\.class", init_text)
        if m:
            return ("child_workflow_stub", m.group(1).split(".")[-1])
        if type_name in self._activity_iface_names:
            return ("activity_stub", type_name)
        if type_name in self._workflow_iface_names:
            return ("child_workflow_stub", type_name)
        if self.graph.find_class_by_name(type_name):
            return ("helper", type_name)
        return None

    def resolve_declared_kinds(self, file_path: str, scope_node: tree_sitter.Node) -> KindMap:
        """Maps every field/local variable name declared under `scope_node` to its resolved kind."""
        kinds: KindMap = {}
        for decl_type in ("field_declaration", "local_variable_declaration"):
            for n in find_all_nodes(scope_node, decl_type):
                type_node = n.child_by_field_name("type")
                type_name = self.source.node_text(file_path, type_node) if type_node else ""
                for decl in n.named_children:
                    if decl.type != "variable_declarator":
                        continue
                    name_node = decl.child_by_field_name("name")
                    value_node = decl.child_by_field_name("value")
                    if not name_node:
                        continue
                    var_name = self.source.node_text(file_path, name_node)
                    init_text = self.source.node_text(file_path, value_node) if value_node else ""
                    kind = self._classify_declaration(type_name, init_text)
                    if kind:
                        kinds[var_name] = kind
        return kinds

    # -- statement walk ---------------------------------------------------

    def walk_method(self, file_path: str, method_node: tree_sitter.Node, kinds: KindMap, depth: int = 0) -> List[CallSite]:
        body = method_node.child_by_field_name("body")
        if not body:
            return []
        # Local vars declared anywhere in this method augment the class-level kinds.
        local_kinds = dict(kinds)
        local_kinds.update(self.resolve_declared_kinds(file_path, body))

        call_sites: List[CallSite] = []
        self._walk_statement(file_path, body, [], False, local_kinds, call_sites, depth)
        return call_sites

    def _walk_statement(self, fp: str, node: tree_sitter.Node, ctx_stack: List[str], saga_flag: bool,
                         kinds: KindMap, call_sites: List[CallSite], depth: int) -> None:
        node_type = node.type

        if node_type == "if_statement":
            cond_node = node.child_by_field_name("condition")
            cond_text = self.source.node_text(fp, cond_node).strip() if cond_node else ""
            consequence = node.child_by_field_name("consequence")
            alternative = node.child_by_field_name("alternative")
            if consequence:
                self._walk_statement(fp, consequence, ctx_stack + [f"if: {cond_text}"], saga_flag, kinds, call_sites, depth)
            if alternative:
                self._walk_statement(fp, alternative, ctx_stack + ["else"], saga_flag, kinds, call_sites, depth)
            return

        if node_type == "try_statement":
            self._walk_try_statement(fp, node, ctx_stack, saga_flag, kinds, call_sites, depth)
            return

        if node_type in ("while_statement", "for_statement", "enhanced_for_statement"):
            body = node.child_by_field_name("body")
            if body:
                self._walk_statement(fp, body, ctx_stack + ["loop"], saga_flag, kinds, call_sites, depth)
            return

        if node_type == "method_invocation":
            self._record_call_site(fp, node, ctx_stack, saga_flag, kinds, call_sites, depth)
            # Recurse into the receiver too, so a chained call like
            # `Promise.allOf(p1, p2).get()` also surfaces the inner
            # `Promise.allOf(...)` invocation as its own call site.
            receiver = node.child_by_field_name("object")
            if receiver:
                self._walk_statement(fp, receiver, ctx_stack, saga_flag, kinds, call_sites, depth)
            arguments = node.child_by_field_name("arguments")
            if arguments:
                for c in arguments.named_children:
                    self._walk_statement(fp, c, ctx_stack, saga_flag, kinds, call_sites, depth)
            return

        for c in node.named_children:
            self._walk_statement(fp, c, ctx_stack, saga_flag, kinds, call_sites, depth)

    def _walk_try_statement(self, fp: str, node: tree_sitter.Node, ctx_stack: List[str], saga_flag: bool,
                             kinds: KindMap, call_sites: List[CallSite], depth: int) -> None:
        body = node.child_by_field_name("body")
        if body:
            self._walk_statement(fp, body, ctx_stack + ["try"], saga_flag, kinds, call_sites, depth)

        for clause in node.named_children:
            if clause.type != "catch_clause":
                continue
            header = self.source.node_text(fp, clause).split("{", 1)[0]
            m = re.search(r"catch\s*\(\s*([\w.]+)", header)
            exc_type = m.group(1) if m else "Exception"
            clause_body = clause.child_by_field_name("body")
            is_saga_catch = bool(clause_body and SAGA_TRIGGER_RE.search(self.source.node_text(fp, clause_body)))
            if clause_body:
                self._walk_statement(fp, clause_body, ctx_stack + [f"catch: {exc_type}"], saga_flag or is_saga_catch, kinds, call_sites, depth)

        for clause in node.named_children:
            if clause.type != "finally_clause":
                continue
            finally_body = clause.child_by_field_name("body") or (clause.named_children[0] if clause.named_children else None)
            if finally_body:
                self._walk_statement(fp, finally_body, ctx_stack + ["finally"], saga_flag, kinds, call_sites, depth)

    def _record_call_site(self, fp: str, node: tree_sitter.Node, ctx_stack: List[str], saga_flag: bool,
                           kinds: KindMap, call_sites: List[CallSite], depth: int) -> None:
        obj_node = node.child_by_field_name("object")
        name_node = node.child_by_field_name("name")
        if not name_node:
            return
        method_name = self.source.node_text(fp, name_node)
        obj_name = self.source.node_text(fp, obj_node) if obj_node else None
        ctx = ctx_stack[-1] if ctx_stack else None
        line = node.start_point[0] + 1

        def emit(kind: str, resolved_name: str, extra_saga: bool = False) -> None:
            call_sites.append(CallSite(obj_name, method_name, ctx, saga_flag or extra_saga, kind, resolved_name, line, depth))

        # Stateful pause: Workflow.await(...) / Workflow.sleep(...) — surface the
        # await condition text (usually a boolean field a Signal handler sets)
        # so a reader can see *what* the workflow is blocked waiting for.
        if obj_name == "Workflow" and method_name in ("await", "sleep"):
            condition = self._describe_pause_argument(fp, node) if method_name == "await" else None
            label = f"Workflow.await ({condition})" if condition else f"Workflow.{method_name}"
            emit("pause", label)
            return

        # Promise.allOf(...) — the Java Temporal SDK's parallel-wait construct
        # (Promise.all's counterpart): blocks until every listed Promise settles.
        if obj_name == "Promise" and method_name == "allOf":
            emit("pause", "Promise.allOf (parallel wait)")
            return

        # Async.procedure(target::method, ...) — resolve the method reference's object.
        if obj_name == "Async" and method_name in ("procedure", "function"):
            if self._try_record_method_reference(fp, node, kinds, emit):
                return

        kind_info = kinds.get(obj_name) if obj_name else None
        if kind_info:
            kind, target = kind_info
            if kind == "activity_stub":
                emit("activity", f"{target}.{method_name}")
                return
            if kind == "child_workflow_stub":
                emit("child_workflow", f"{target}.{method_name}")
                return
            if kind == "untyped_activity_stub" and method_name == "execute":
                self._record_dynamic_activity_dispatch(fp, node, emit)
                return
            if kind == "helper":
                is_trigger = bool(SAGA_TRIGGER_RE.search(method_name))
                emit("helper", f"{target}.{method_name}", extra_saga=is_trigger)
                return

        # Determinism check: unresolved object whose declared type looks like raw I/O.
        # (No stub/helper mapping means it's not routed through an Activity.)
        emit("internal", method_name)

    def _try_record_method_reference(self, fp: str, node: tree_sitter.Node, kinds: KindMap, emit) -> bool:
        """Resolves `Async.procedure(target::method, ...)` to a Child Workflow call site."""
        arguments = node.child_by_field_name("arguments")
        ref = next((a for a in (arguments.named_children if arguments else []) if a.type == "method_reference"), None)
        if ref is None or len(ref.named_children) < 2:
            return False
        ref_obj = self.source.node_text(fp, ref.named_children[0])
        ref_method = self.source.node_text(fp, ref.named_children[1])
        kind_info = kinds.get(ref_obj)
        if kind_info and kind_info[0] == "child_workflow_stub":
            emit("child_workflow", f"{kind_info[1]}.{ref_method}")
            return True
        return False

    def _record_dynamic_activity_dispatch(self, fp: str, node: tree_sitter.Node, emit) -> None:
        """Resolves `ActivityStub.execute(<activityType>, ...)`: a literal name if statically known,
        else an unresolved marker (lbug's own CALLS edges never see these — no static target)."""
        arguments = node.child_by_field_name("arguments")
        first_arg = arguments.named_children[0] if arguments and arguments.named_children else None
        literal = self._string_literal_value(fp, first_arg)
        if literal:
            emit("activity", literal)
        else:
            emit("dynamic_activity", "Dynamic Activity Dispatch (unresolved)")

    def _describe_pause_argument(self, fp: str, invocation_node: tree_sitter.Node) -> Optional[str]:
        """Extracts the boolean condition text from `Workflow.await(() -> <condition>)`."""
        arguments = invocation_node.child_by_field_name("arguments")
        first_arg = arguments.named_children[0] if arguments and arguments.named_children else None
        if first_arg is None:
            return None
        if first_arg.type == "lambda_expression":
            body = first_arg.child_by_field_name("body")
            text = self.source.node_text(fp, body) if body else self.source.node_text(fp, first_arg)
        else:
            text = self.source.node_text(fp, first_arg)
        text = " ".join(text.split())
        return text[:47] + "..." if len(text) > 50 else text

    def _string_literal_value(self, fp: str, node: Optional[tree_sitter.Node]) -> Optional[str]:
        if node is None or node.type != "string_literal":
            return None
        frag = next((c for c in node.named_children if c.type == "string_fragment"), None)
        return self.source.node_text(fp, frag) if frag else None


# ============================================================================
# Layer 3: Architectural Boundary Mapping
# ============================================================================

class BoundaryMapper:
    """Buckets each Layer 2 call site into Ingress/Orchestrator/Activity/ChildWorkflow roles."""

    def __init__(self, graph: LadybugSource, source: SourceCache, extractor: PrimitiveExtractor, signatures: TemporalSignatures):
        self.graph = graph
        self.source = source
        self.extractor = extractor
        self.signatures = signatures
        self.walker = MethodBodyWalker(source, extractor, graph)

    def trace_all_workflows(self) -> List[Dict[str, Any]]:
        workflows = []
        for iface_id, iface in self.extractor.workflow_interfaces.items():
            roles = self.extractor.method_roles.get(iface_id, {})
            entry_methods = [name for name, role in roles.items() if role == "entry"]
            if not entry_methods:
                continue
            impl = self.extractor.implementation_of(iface_id)
            if not impl:
                continue
            task_queue = self.extractor.task_queue_of(impl)
            secondary_ingress = [
                {"name": name, "role": role}
                for name, role in roles.items()
                if role in ("signal", "query", "update")
            ]

            for entry_name in entry_methods:
                wf = self._trace_workflow(iface, impl, entry_name, task_queue, secondary_ingress)
                if wf:
                    workflows.append(wf)
        return workflows

    def _trace_workflow(self, iface: InterfaceNode, impl: ClassNode, entry_name: str,
                         task_queue: Optional[str], secondary_ingress: List[Dict[str, str]]) -> Optional[Dict[str, Any]]:
        type_node = self.source.find_type_declaration(impl.filePath, impl.name)
        base_kinds = self.walker.resolve_declared_kinds(impl.filePath, type_node) if type_node else {}

        nodes = {
            "Ingress": [{"name": entry_name, "kind": "start"}] + secondary_ingress,
            "Orchestrator": [{"name": entry_name, "filePath": impl.filePath, "taskQueue": task_queue}],
            "Activity": [],
            "ChildWorkflow": [],
            "Pause": [],
        }
        edges: List[Dict[str, Any]] = []
        violations: List[Dict[str, str]] = []

        entry_call_sites = self._trace_method(impl, entry_name, base_kinds)
        if entry_call_sites is None:
            return None
        self._collect_call_site_effects(entry_call_sites, entry_name, "orchestrator", impl, task_queue, nodes, edges, violations)

        # Signal/Query/Update handlers run as their own code path triggered
        # directly by the ingress event — walk each one too, so a signal that
        # (e.g.) fires a cancellation Activity actually shows up in the diagram
        # instead of being rendered as an inert label.
        for ing in secondary_ingress:
            handler_call_sites = self._trace_method(impl, ing["name"], base_kinds)
            if handler_call_sites is None:
                continue
            self._collect_call_site_effects(handler_call_sites, ing["name"], "ingress", impl, task_queue, nodes, edges, violations)

        return {
            "id": f"{iface.name}_{entry_name}",
            "title": f"Temporal Workflow: {iface.name}.{entry_name}",
            "nodes": nodes,
            "edges": edges,
            "violations": violations,
        }

    def _trace_method(self, impl: ClassNode, method_name: str, base_kinds: KindMap) -> Optional[List[CallSite]]:
        """Walks one Impl method's body and resolves indirect (helper/child-workflow) targets."""
        method_node = self.source.find_method_declaration(impl.filePath, impl.name, method_name)
        if not method_node:
            return None
        call_sites = self.walker.walk_method(impl.filePath, method_node, base_kinds, depth=0)
        call_sites.extend(self._expand_indirect_calls(call_sites, visited=set(), depth=1))
        return call_sites

    def _collect_call_site_effects(self, call_sites: List[CallSite], source_name: str, source_kind: str,
                                    impl: ClassNode, task_queue: Optional[str],
                                    nodes: Dict[str, List[Dict[str, Any]]], edges: List[Dict[str, Any]],
                                    violations: List[Dict[str, str]]) -> None:
        """Buckets one traced method's call sites into `nodes`/`edges`/`violations` in place."""
        for cs in call_sites:
            if cs.kind == "activity":
                nodes["Activity"].append({"name": cs.resolved_name})
                edges.append(self._make_edge(source_name, source_kind, cs, "Task Queue", task_queue))
            elif cs.kind == "dynamic_activity":
                nodes["Activity"].append({"name": cs.resolved_name, "unresolved": True})
                edges.append(self._make_edge(source_name, source_kind, cs, "Task Queue", task_queue))
            elif cs.kind == "child_workflow":
                nodes["ChildWorkflow"].append({"name": cs.resolved_name})
                edges.append(self._make_edge(source_name, source_kind, cs, "Child Workflow Queue", None))
            elif cs.kind == "pause":
                nodes["Pause"].append({"name": cs.resolved_name})
                edges.append(self._make_edge(source_name, source_kind, cs, None, None))
            elif cs.kind == "helper":
                edges.append(self._make_edge(source_name, source_kind, cs, None, None))
            elif cs.kind == "internal" and cs.object_name:
                violation = self._check_determinism_violation(impl, source_name, cs)
                if violation:
                    violations.append(violation)

    def _expand_indirect_calls(self, call_sites: List[CallSite], visited: set, depth: int) -> List[CallSite]:
        """Recurses into 'helper' and 'child_workflow' call targets (e.g. a Saga helper that
        itself starts a compensating Child Workflow) up to MAX_RECURSE_DEPTH."""
        if depth > MAX_RECURSE_DEPTH:
            return []
        expanded: List[CallSite] = []
        for cs in call_sites:
            if cs.kind not in ("helper", "child_workflow") or cs.depth != depth - 1:
                continue
            target_class = self._resolve_indirect_target_class(cs)
            if not target_class:
                continue
            target_method_name = cs.resolved_name.split(".")[-1]
            key = (target_class.id, target_method_name)
            if key in visited:
                continue
            visited.add(key)

            method_node = self.source.find_method_declaration(target_class.filePath, target_class.name, target_method_name)
            if not method_node:
                continue
            type_node = self.source.find_type_declaration(target_class.filePath, target_class.name)
            kinds = self.walker.resolve_declared_kinds(target_class.filePath, type_node) if type_node else {}
            nested = self.walker.walk_method(target_class.filePath, method_node, kinds, depth=depth)
            for n in nested:
                n.saga_compensation = n.saga_compensation or cs.saga_compensation
            expanded.extend(nested)

        if expanded:
            expanded.extend(self._expand_indirect_calls(call_sites + expanded, visited, depth + 1))
        return expanded

    def _resolve_indirect_target_class(self, cs: CallSite) -> Optional[ClassNode]:
        owner_name = cs.resolved_name.split(".")[0]
        if cs.kind == "helper":
            return self.graph.find_class_by_name(owner_name)
        # child_workflow -> find its Impl class via the interface it was declared on.
        target_iface = self.graph.find_interface_by_name(owner_name)
        return self.extractor.implementation_of(target_iface.id) if target_iface else None

    def _check_determinism_violation(self, impl: ClassNode, source_name: str, cs: CallSite) -> Optional[Dict[str, str]]:
        """Flags raw I/O (DB/HTTP/MQ client) called directly from an Orchestrator body,
        instead of being routed through an Activity stub."""
        type_name = self._declared_type_of(impl, cs.object_name)
        looks_like_egress = type_name and (
            GENERIC_EGRESS_TYPE_RE.search(type_name)
            or any(p.search(type_name) for p in self.signatures.generic_egress)
        )
        if not looks_like_egress:
            return None
        return {
            "source": source_name,
            "target": f"{cs.object_name}.{cs.method_name}",
            "type": "Determinism Violation: IO in Orchestrator",
        }

    def _declared_type_of(self, impl: ClassNode, obj_name: str) -> Optional[str]:
        type_node = self.source.find_type_declaration(impl.filePath, impl.name)
        if not type_node:
            return None
        for n in find_all_nodes(type_node, "field_declaration"):
            type_annotation = n.child_by_field_name("type")
            for decl in n.named_children:
                if decl.type != "variable_declarator":
                    continue
                name_node = decl.child_by_field_name("name")
                if name_node and self.source.node_text(impl.filePath, name_node) == obj_name:
                    return self.source.node_text(impl.filePath, type_annotation) if type_annotation else None
        return None

    @staticmethod
    def _make_edge(source: str, source_kind: str, cs: CallSite, boundary_label: Optional[str], task_queue: Optional[str]) -> Dict[str, Any]:
        boundary = None
        if boundary_label:
            boundary = f"{boundary_label}: {task_queue}" if task_queue else boundary_label
        return {
            "source": source,
            # 'orchestrator' -> draw from the Orchestrator box; 'ingress' -> draw
            # from the triggering Signal/Query/Update box (it runs as its own
            # code path, not something the orchestrator's main flow calls into).
            "sourceKind": source_kind,
            "target": cs.resolved_name,
            "context": cs.context,
            "saga_compensation": cs.saga_compensation,
            "kind": cs.kind,
            "networkBoundary": boundary,
        }


# ============================================================================
# Rendering — Mermaid + SVG (styled after workflow_pipeline.py's Stage 2/3)
# ============================================================================

_MMD_CLASS_DEFS = [
    "classDef ingress fill:#065f46,stroke:#10b981,stroke-width:2.5px,color:#ecfdf5,font-weight:bold;",
    "classDef orchestrator fill:#581c87,stroke:#d946ef,stroke-width:2.5px,color:#faf5ff,font-weight:bold;",
    "classDef activity fill:#7f1d1d,stroke:#ef4444,stroke-width:2.5px,color:#fef2f2,font-weight:bold;",
    "classDef childwf fill:#7c2d12,stroke:#f97316,stroke-width:2px,color:#fff7ed;",
    "classDef pause fill:#78350f,stroke:#f59e0b,stroke-width:2px,color:#fffbeb;",
    "classDef saga fill:#3730a3,stroke:#818cf8,stroke-width:2.5px,color:#eef2ff,stroke-dasharray: 4 3;",
    "classDef violation fill:#fee2e2,stroke:#b91c1c,stroke-width:3px,color:#991b1b,stroke-dasharray: 5 5;",
]
_NODE_ICONS_BY_ROLE = (("Activity", "🛠️", "activity"), ("ChildWorkflow", "🧵", "childwf"), ("Pause", "⏸️", "pause"))
_EDGE_ROLE_PREFIX = {"activity": "AC", "dynamic_activity": "AC", "child_workflow": "CH", "pause": "PA"}


def sanitize_id(s: str) -> str:
    return re.sub(r"[^a-zA-Z0-9_]", "_", s)


def render_mmd(workflows: List[Dict[str, Any]]) -> str:
    mmd = [
        "%%{init: {'theme': 'dark', 'themeVariables': { 'darkMode': true, 'primaryColor': '#1e293b', 'edgeLabelBackground':'#0f172a'}}}%%",
        "flowchart TD",
        *(f"    {line}" for line in _MMD_CLASS_DEFS),
        "",
    ]
    for wf in workflows:
        mmd.extend(_render_workflow_subgraph(wf))
    return "\n".join(mmd)


def _render_workflow_subgraph(wf: Dict[str, Any]) -> List[str]:
    wf_id = sanitize_id(wf["id"])
    lines = [
        f"    subgraph {wf_id} [\"⚡ {html.escape(wf['title'])}\"]",
        "        direction LR",
    ]
    violation_targets = {v["target"] for v in wf["violations"]}

    for ing in wf["nodes"]["Ingress"]:
        n_id = f"{wf_id}_IN_{sanitize_id(ing['name'])}"
        label = f"🟢 {ing['name']}" if ing.get("kind") == "start" else f"🟢 {ing['role'].upper()}: {ing['name']}"
        lines.append(f"        {n_id}[\"{html.escape(label)}\"]:::ingress")

    orch = wf["nodes"]["Orchestrator"][0]
    orch_id = f"{wf_id}_ORCH"
    tq = f"<br/><small>Queue: {html.escape(orch['taskQueue'])}</small>" if orch.get("taskQueue") else ""
    lines.append(f"        {orch_id}[\"⏳ {html.escape(orch['name'])}{tq}\"]:::orchestrator")
    for ing in wf["nodes"]["Ingress"]:
        n_id = f"{wf_id}_IN_{sanitize_id(ing['name'])}"
        lines.append(f"        {n_id} --> {orch_id}")

    seen_nodes = set()
    for role, icon, css in _NODE_ICONS_BY_ROLE:
        for item in wf["nodes"][role]:
            n_id = f"{wf_id}_{role[:2].upper()}_{sanitize_id(item['name'])}"
            if n_id in seen_nodes:
                continue
            seen_nodes.add(n_id)
            final_css = "violation" if item["name"] in violation_targets else css
            unresolved = " ⚠️" if item.get("unresolved") else ""
            lines.append(f"        {n_id}[\"{icon} {html.escape(item['name'])}{unresolved}\"]:::{final_css}")

    for edge in wf["edges"]:
        if edge["kind"] not in _EDGE_ROLE_PREFIX:
            continue
        role_prefix = _EDGE_ROLE_PREFIX[edge["kind"]]
        tgt_id = f"{wf_id}_{role_prefix}_{sanitize_id(edge['target'])}"
        # A Signal/Query/Update handler runs as its own code path triggered by
        # the ingress event, not something the Orchestrator's main flow calls
        # into — draw its downstream edges from the ingress box directly.
        src_id = orch_id if edge["sourceKind"] == "orchestrator" else f"{wf_id}_IN_{sanitize_id(edge['source'])}"
        label_parts = [p for p in (edge["networkBoundary"], edge["context"]) if p]
        label = f"|[{html.escape(' / '.join(label_parts))}]|" if label_parts else ""
        style = ":::saga" if edge["saga_compensation"] else ""
        lines.append(f"        {src_id} -.->{label} {tgt_id}{style}")

    lines.append("    end")
    lines.append("")
    return lines


def _parse_mmd_subgraphs(mmd_text: str) -> List[Dict[str, Any]]:
    """Parses this module's own `render_mmd` output back into {id, title, nodes, edges}
    per workflow, so `render_svg` can draw from structured data rather than raw text."""
    subgraphs: List[Dict[str, Any]] = []
    current: Optional[Dict[str, Any]] = None

    for line in mmd_text.splitlines():
        line = line.strip()
        if line.startswith("subgraph"):
            m = re.search(r'subgraph\s+(\w+)\s+\["(.+?)"\]', line)
            if m:
                current = {"id": m.group(1), "title": m.group(2), "nodes": [], "edges": []}
                subgraphs.append(current)
        elif line.startswith("end") and current:
            current = None
        elif current:
            node_match = re.match(r'(\w+)\["(.+?)"\](?::::(\w+))?', line)
            if node_match:
                n_id, raw_label, cls = node_match.group(1), node_match.group(2), node_match.group(3) or "orchestrator"
                title_part = re.sub(r"<br/><small>.*?</small>", "", raw_label)
                for emoji in ("🟢 ", "⏳ ", "🛠️ ", "🧵 ", "⏸️ "):
                    title_part = title_part.replace(emoji, "")
                current["nodes"].append({"id": n_id, "title": title_part, "class": cls})
            elif "-.->" in line or "-->" in line:
                dashed = "-.->" in line
                e_match = re.match(r'(\w+)\s+(?:-\.->|-->)\s*(?:\|\[(.+?)\]\|)?\s*(\w+)(?::::(\w+))?', line)
                if e_match:
                    src, edge_label, tgt, edge_cls = e_match.groups()
                    current["edges"].append({
                        "src": src, "tgt": tgt, "label": edge_label or "",
                        "saga": edge_cls == "saga", "dashed": dashed,
                    })

    return subgraphs


_SVG_PALETTE = {
    "ingress": ("#065f46", "#10b981"),
    "orchestrator": ("#581c87", "#d946ef"),
    "activity": ("#7f1d1d", "#ef4444"),
    "childwf": ("#7c2d12", "#f97316"),
    "pause": ("#78350f", "#f59e0b"),
    "saga": ("#3730a3", "#818cf8"),
    "violation": ("#fee2e2", "#b91c1c"),
}


def render_svg(mmd_text: str) -> str:
    subgraphs = _parse_mmd_subgraphs(mmd_text)

    svg_width = 1200
    row_h = 170
    svg_height = max(400, len(subgraphs) * row_h + 120)

    svg = [
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {svg_width} {svg_height}" width="{svg_width}" height="{svg_height}">',
        "  <defs>",
        '    <linearGradient id="bgGrad" x1="0%" y1="0%" x2="100%" y2="100%">',
        '      <stop offset="0%" stop-color="#0b1120"/><stop offset="100%" stop-color="#1e293b"/>',
        "    </linearGradient>",
        '    <marker id="arrow" viewBox="0 0 10 10" refX="6" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">',
        '      <path d="M 0 1 L 10 5 L 0 9 z" fill="#38bdf8"/>',
        "    </marker>",
        "  </defs>",
        f'  <rect width="{svg_width}" height="{svg_height}" fill="url(#bgGrad)"/>',
        '  <text x="35" y="45" fill="#38bdf8" font-family="system-ui, sans-serif" font-size="20" font-weight="bold">⚡ Temporal Conditional Transaction Flows</text>',
        f'  <text x="35" y="70" fill="#94a3b8" font-family="system-ui, sans-serif" font-size="12">Discovered Workflows: {len(subgraphs)}</text>',
    ]

    y_offset = 95
    for sg in subgraphs:
        svg.extend(_render_workflow_card_svg(sg, y_offset, row_h))
        y_offset += row_h

    svg.append("</svg>")
    return "\n".join(svg)


def _render_workflow_card_svg(sg: Dict[str, Any], y_offset: int, row_h: int) -> List[str]:
    nodes_list, edges_list = sg["nodes"], sg["edges"]
    svg = [
        f'  <g transform="translate(35, {y_offset})">',
        f'    <rect width="1130" height="{row_h - 25}" rx="10" fill="#1e293b" stroke="#334155" stroke-width="1.5"/>',
        f'    <text x="20" y="26" fill="#f59e0b" font-family="system-ui, sans-serif" font-size="13" font-weight="bold">{html.escape(sg["title"])}</text>',
    ]

    node_coords = {}
    num_nodes = max(1, len(nodes_list))
    box_w = min(210, (1090 - (num_nodes - 1) * 25) // num_nodes)
    for n_idx, nd in enumerate(nodes_list):
        x = 20 + n_idx * (box_w + 25)
        y, h = 45, 75
        fill, stroke = _SVG_PALETTE.get(nd["class"], _SVG_PALETTE["orchestrator"])
        safe_title = html.escape(nd["title"])
        if len(safe_title) > 26:
            safe_title = safe_title[:24] + "…"
        svg.append(f'    <rect x="{x}" y="{y}" width="{box_w}" height="{h}" rx="6" fill="{fill}" stroke="{stroke}" stroke-width="1.8"/>')
        svg.append(f'    <text x="{x + 8}" y="{y + 20}" fill="{stroke}" font-family="system-ui, sans-serif" font-size="8.5" font-weight="bold">{nd["class"].upper()}</text>')
        svg.append(f'    <text x="{x + 8}" y="{y + 45}" fill="#f8fafc" font-family="system-ui, sans-serif" font-size="11" font-weight="600">{safe_title}</text>')
        node_coords[nd["id"]] = (x, y, box_w, h)

    edges_by_src: Dict[str, int] = {}
    for e in edges_list:
        if e["src"] not in node_coords or e["tgt"] not in node_coords:
            continue
        x1, y1, w1, h1 = node_coords[e["src"]]
        x2, y2, w2, h2 = node_coords[e["tgt"]]
        slot = edges_by_src.get(e["src"], 0)
        edges_by_src[e["src"]] = slot + 1
        mid_y = y1 + h1 // 2
        if not e["dashed"]:
            dash = ""
        else:
            dash = ' stroke-dasharray="6 4"' if e["saga"] else ' stroke-dasharray="4 3"'
        color = "#818cf8" if e["saga"] else "#38bdf8"
        svg.append(f'    <line x1="{x1 + w1}" y1="{mid_y}" x2="{x2}" y2="{mid_y}" stroke="{color}"{dash} stroke-width="2" marker-end="url(#arrow)"/>')
        if e["label"]:
            label = html.escape(e["label"])
            if len(label) > 28:
                label = label[:26] + "…"
            label_y = mid_y - 6 - (slot % 2) * 11
            svg.append(f'    <text x="{(x1 + w1 + x2) // 2}" y="{label_y}" fill="#94a3b8" font-family="system-ui, sans-serif" font-size="8.5" text-anchor="middle">{label}</text>')

    svg.append("  </g>")
    return svg


# ============================================================================
# CLI
# ============================================================================

def run_pipeline(project_dir: str, output_dir: Optional[str] = None) -> Dict[str, Any]:
    proj_path = Path(project_dir).resolve()
    out_path = Path(output_dir).resolve() if output_dir else proj_path / ".gitnexus" / "temporal"
    out_path.mkdir(parents=True, exist_ok=True)

    print("==================================================")
    print("⚡ STATICALLY INFERRED TEMPORAL FLOW VISUALIZER")
    print(f"   Target:  {proj_path}")
    print(f"   Outputs: {out_path}")
    print("==================================================")

    signatures = TemporalSignatures(load_sdk_registry())
    graph = LadybugSource(proj_path)
    source = SourceCache(proj_path)

    print("🔍 [1/3] Layer 1 — classifying Temporal primitives (Workflow/Activity contracts)...")
    extractor = PrimitiveExtractor(graph, source, signatures)
    extractor.classify_all()
    print(f"   ✓ {len(extractor.workflow_interfaces)} Workflow contract(s), {len(extractor.activity_interfaces)} Activity contract(s)")

    print("🧠 [2/3] Layer 2+3 — walking control flow and mapping architectural boundaries...")
    mapper = BoundaryMapper(graph, source, extractor, signatures)
    workflows = mapper.trace_all_workflows()
    print(f"   ✓ {len(workflows)} Temporal workflow flow(s) traced")

    json_file = out_path / "temporal_flow.json"
    with open(json_file, "w", encoding="utf-8") as f:
        json.dump({"project": str(proj_path), "workflows": workflows}, f, indent=2)
    print(f"   ✓ {json_file.name}")

    print("🖼️  [3/3] Rendering Mermaid + SVG...")
    mmd_text = render_mmd(workflows)
    mmd_file = out_path / "temporal_flow.mmd"
    with open(mmd_file, "w", encoding="utf-8") as f:
        f.write(mmd_text)
    print(f"   ✓ {mmd_file.name}")

    svg_text = render_svg(mmd_text)
    svg_file = out_path / "temporal_flow.svg"
    with open(svg_file, "w", encoding="utf-8") as f:
        f.write(svg_text)
    print(f"   ✓ {svg_file.name}")

    for wf in workflows:
        if wf["violations"]:
            print(f"   ⚠️  {wf['title']}: {len(wf['violations'])} determinism violation(s)")
            for v in wf["violations"]:
                print(f"      - {v['source']} directly called {v['target']}")

    print("==================================================")
    print("✅ Temporal Flow Pipeline Completed Successfully!")
    print("==================================================")
    return {"workflows": workflows}


def main():
    parser = argparse.ArgumentParser(description="Statically Inferred Temporal Flow Visualizer")
    parser.add_argument("project_dir", help="Path to a GitNexus-indexed project (.gitnexus/lbug)")
    parser.add_argument("--output-dir", default=None, help="Output directory (default: <project>/.gitnexus/temporal)")
    args = parser.parse_args()
    run_pipeline(args.project_dir, args.output_dir)


if __name__ == "__main__":
    main()
