"""
Python Data Classes for GitNexus Knowledge Graph (Matching TypeScript AST & Schema).

Provides strongly-typed Python dataclasses mirroring the TypeScript data structures
stored in LadybugDB (.gitnexus/lbug).
"""

from dataclasses import dataclass, field
from typing import List, Optional, Dict, Any

@dataclass
class CodeRelation:
    """Represents a relationship edge between two code nodes in LadybugDB."""
    source_id: str
    target_id: str
    type: str
    confidence: float = 1.0
    reason: str = ""
    step: int = 0

@dataclass
class BaseNode:
    """Base class for all code entities in the knowledge graph."""
    id: str
    name: str
    file_path: str = ""
    start_line: int = 1
    end_line: int = 1
    properties: Dict[str, Any] = field(default_factory=dict)

@dataclass
class ClassNode(BaseNode):
    """Represents a class definition in the knowledge graph."""
    namespace: str = ""
    framework_annotations: List[str] = field(default_factory=list)

@dataclass
class InterfaceNode(BaseNode):
    """Represents an interface contract in the knowledge graph."""
    namespace: str = ""

@dataclass
class MethodNode(BaseNode):
    """Represents a method attached to a class or struct."""
    signature: str = ""
    parameter_count: int = 0
    return_type: str = ""
    is_exported: bool = True

@dataclass
class FunctionNode(BaseNode):
    """Represents a top-level function definition."""
    signature: str = ""
    is_exported: bool = True

@dataclass
class RouteNode(BaseNode):
    """Represents an HTTP/REST endpoint route (Ingress)."""
    method: str = "GET"
    path: str = ""
    handler_symbol_id: str = ""

@dataclass
class ProcessNode:
    """Represents an end-to-end execution flow through the codebase."""
    id: str
    label: str
    entry_point_id: str
    terminal_id: str
    step_count: int = 1
    process_type: str = "standard"
    communities: List[str] = field(default_factory=list)

@dataclass
class CommunityNode:
    """Represents a functional code cluster detected by the Leiden algorithm."""
    id: str
    label: str
    size: int = 1
    cohesion: float = 1.0
    keywords: List[str] = field(default_factory=list)

@dataclass
class FileNode:
    """Represents a source file in the repository."""
    id: str
    name: str
    path: str

@dataclass
class FolderNode:
    """Represents a filesystem directory in the repository."""
    id: str
    name: str
    path: str

@dataclass
class ProcessStep:
    """Represents a single step along an execution flow trace."""
    step_number: int
    node_id: str
    node_name: str
    file_path: str
