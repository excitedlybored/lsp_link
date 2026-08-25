"""Typed records for legacy GitNexus and first-class LSP Ladybug graphs."""

from dataclasses import dataclass, field
from typing import List, Optional, Dict, Any


@dataclass(frozen=True)
class LspPosition:
    line: int
    character: int


@dataclass(frozen=True)
class LspRange:
    start: LspPosition
    end: LspPosition


@dataclass
class LspAnalysisRunNode:
    id: str
    workspace_uri: str
    repository_path: Optional[str]
    protocol_version: str
    position_encoding: str
    status: str
    started_at: str
    completed_at: Optional[str]
    requested_languages: List[str]
    configuration_hash: Optional[str]
    error_count: int
    timeout_count: int


@dataclass
class LspBuildRootNode:
    id: str
    run_id: str
    workspace_uri: str
    repository_path: Optional[str]
    relative_path: str
    build_systems: List[str]
    java_major: Optional[int]
    import_status: str
    configuration_hash: Optional[str]
    excluded_root_ids: List[str]


@dataclass
class LspServerNode:
    id: str
    run_id: str
    name: str
    version: Optional[str]
    language_id: str
    command: Optional[str]
    status: str
    capabilities_json: str
    build_root_id: Optional[str]


@dataclass
class LspDocumentNode:
    id: str
    uri: str
    file_path: Optional[str]
    language_id: str
    version: Optional[int]
    content_hash: Optional[str]
    origin: str
    was_opened: bool
    build_root_id: Optional[str]


@dataclass
class LspSymbolNode:
    id: str
    table: str
    document_id: str
    uri: str
    name: str
    detail: Optional[str]
    kind: int
    kind_name: str
    container_name: Optional[str]
    range: LspRange
    selection_range: LspRange
    signature: Optional[str]
    stable_key: str
    is_external: bool

    @property
    def file_path(self) -> str:
        return self.uri.removeprefix("file://")


@dataclass
class LspCallTarget:
    id: str
    name: str
    kind: Optional[str]
    mapping_confidence: float
    status: str
    provider_authority: float
    is_derived: bool
    reason: Optional[str]


@dataclass
class LspCallSiteNode:
    """One ranged call observation with zero or more independent resolutions."""

    id: str
    run_id: str
    server_id: str
    caller_id: str
    caller_name: str
    document_id: str
    capability: str
    direction: str
    range: LspRange
    callee_name: Optional[str]
    status: str
    resolutions: List[LspCallTarget] = field(default_factory=list)


@dataclass
class LspOccurrenceNode:
    id: str
    run_id: str
    server_id: str
    document_id: str
    capability: str
    request_uri: Optional[str]
    request_position: Optional[LspPosition]
    uri: str
    range: LspRange
    selection_range: Optional[LspRange]
    origin_uri: Optional[str]
    origin_range: Optional[LspRange]
    role: str
    status: str
    mappings: List["LspOccurrenceMapping"] = field(default_factory=list)


@dataclass
class LspOccurrenceMapping:
    target_id: str
    target_name: str
    relation_kind: str
    mapping_confidence: float
    status: str
    provider_authority: float
    is_derived: bool
    reason: Optional[str]


@dataclass
class LspDiagnosticNode:
    id: str
    run_id: str
    server_id: str
    document_id: str
    capability: str
    range: LspRange
    severity: Optional[int]
    code: Optional[str]
    code_href: Optional[str]
    source: Optional[str]
    message: str
    tags: List[int]
    related_information_json: Optional[str]
    status: str


@dataclass
class LspHoverNode:
    id: str
    run_id: str
    server_id: str
    document_id: str
    capability: str
    request_position: LspPosition
    range: Optional[LspRange]
    content_format: str
    contents: str
    status: str


@dataclass
class LspSemanticTokenNode:
    id: str
    run_id: str
    server_id: str
    document_id: str
    capability: str
    line: int
    character: int
    length: int
    token_type: str
    token_modifiers: List[str]
    status: str


@dataclass
class LspSignatureHelpNode:
    id: str
    run_id: str
    server_id: str
    document_id: str
    capability: str
    request_position: LspPosition
    active_signature: Optional[int]
    active_parameter: Optional[int]
    status: str


@dataclass
class LspSignatureNode:
    id: str
    signature_help_id: str
    label: str
    documentation: Optional[str]
    active_parameter: Optional[int]
    ordinal: int


@dataclass
class LspParameterNode:
    id: str
    signature_id: str
    label: str
    label_start: Optional[int]
    label_end: Optional[int]
    documentation: Optional[str]
    ordinal: int


@dataclass
class LspCoverageNode:
    id: str
    run_id: str
    server_id: Optional[str]
    document_id: Optional[str]
    language_id: str
    capability: str
    status: str
    eligible_count: int
    attempted_count: int
    success_count: int
    empty_count: int
    failure_count: int
    timeout_count: int
    result_count: int
    mapped_count: int
    external_count: int
    unmapped_count: int
    exclusion_reason: Optional[str]


@dataclass
class LspRelationRecord:
    source_id: str
    target_id: str
    id: str
    kind: str
    run_id: str
    server_id: Optional[str]
    capability: str
    status: str
    provider_authority: float
    mapping_confidence: float
    is_derived: bool
    reason: Optional[str]
    ordinal: Optional[int]


@dataclass
class JvmArtifactNode:
    id: str
    stage_id: str
    build_root_ids: List[str]
    classpath_providers: List[str]
    classpath_scopes: List[str]
    module_path: bool
    coordinate: Optional[str]
    classpath_entry_path: str
    header_jar_path: Optional[str]
    binary_jar_path: Optional[str]
    source_jar_path: Optional[str]
    source_origin: str
    association_status: str
    class_count: int


@dataclass
class JvmClassNode:
    id: str
    stage_id: str
    artifact_id: str
    binary_name: str
    package_name: str
    simple_name: str
    kind: str
    access: str
    super_name: Optional[str]
    interfaces: List[str]
    source_entry: Optional[str]
    is_seed: bool
    seed_uris: List[str]
    was_disassembled: bool


@dataclass
class JvmArtifactEnrichmentRunNode:
    id: str
    lsp_run_id: str
    status: str
    started_at: str
    completed_at: Optional[str]
    provider: str
    provider_version: Optional[str]
    classpath_providers: List[str]
    classpath_resolution_json: str
    classpath_error_count: int
    artifact_count: int
    class_count: int
    method_count: int
    field_count: int
    call_site_count: int
    error_count: int
    truncated: bool


@dataclass
class JvmMethodNode:
    id: str
    stage_id: str
    class_id: str
    owner: str
    name: str
    descriptor: str
    declaration: str
    access: str
    has_code: bool
    is_external_placeholder: bool


@dataclass
class JvmFieldNode:
    id: str
    stage_id: str
    class_id: str
    owner: str
    name: str
    descriptor: str
    declaration: str
    access: str


@dataclass
class JvmCallSiteNode:
    id: str
    stage_id: str
    caller_method_id: str
    bytecode_offset: int
    opcode: str
    target_owner: str
    target_name: str
    target_descriptor: str
    status: str


@dataclass
class JvmRelationRecord:
    source_id: str
    target_id: str
    id: str
    kind: str
    stage_id: str
    status: str
    ordinal: Optional[int]

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
