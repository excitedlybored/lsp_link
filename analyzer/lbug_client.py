#!/usr/bin/env python3
"""Typed Python client for legacy and LSP-native LadybugDB graphs."""

import sys
from pathlib import Path
from typing import List, Dict, Any, Optional, Tuple
import ladybug

try:
    from .database import resolve_lbug_path, schema_family, table_catalog
    from .models import (
        BaseNode, ClassNode, InterfaceNode, MethodNode, FunctionNode, RouteNode,
        ProcessNode, CommunityNode, FileNode, FolderNode, CodeRelation, ProcessStep,
        JvmArtifactEnrichmentRunNode, JvmArtifactNode, JvmCallSiteNode, JvmClassNode,
        JvmFieldNode, JvmMethodNode, JvmRelationRecord, LspJvmBindingRecord, LspAnalysisRunNode,
        DerivedCallNormalizationRunNode, DerivedCallRelationRecord, LspLogicalInvocationNode,
        LspBuildRootNode, LspCallSiteNode, LspCallTarget, LspCoverageNode,
        LspDiagnosticNode, LspDocumentNode, LspHoverNode, LspOccurrenceMapping,
        LspOccurrenceNode, LspParameterNode, LspPosition, LspRange, LspRelationRecord,
        LspSemanticTokenNode, LspServerNode, LspSignatureHelpNode, LspSignatureNode,
        LspSymbolNode,
    )
except ImportError:  # Direct execution: python analyzer/lbug_client.py
    from database import resolve_lbug_path, schema_family, table_catalog
    from models import (
        BaseNode, ClassNode, InterfaceNode, MethodNode, FunctionNode, RouteNode,
        ProcessNode, CommunityNode, FileNode, FolderNode, CodeRelation, ProcessStep,
        JvmArtifactEnrichmentRunNode, JvmArtifactNode, JvmCallSiteNode, JvmClassNode,
        JvmFieldNode, JvmMethodNode, JvmRelationRecord, LspJvmBindingRecord, LspAnalysisRunNode,
        DerivedCallNormalizationRunNode, DerivedCallRelationRecord, LspLogicalInvocationNode,
        LspBuildRootNode, LspCallSiteNode, LspCallTarget, LspCoverageNode,
        LspDiagnosticNode, LspDocumentNode, LspHoverNode, LspOccurrenceMapping,
        LspOccurrenceNode, LspParameterNode, LspPosition, LspRange, LspRelationRecord,
        LspSemanticTokenNode, LspServerNode, LspSignatureHelpNode, LspSignatureNode,
        LspSymbolNode,
    )


LSP_SYMBOL_TABLES = (
    "LspFileSymbol", "LspModuleSymbol", "LspNamespaceSymbol", "LspPackageSymbol",
    "LspClassSymbol", "LspMethodSymbol", "LspPropertySymbol", "LspFieldSymbol",
    "LspConstructorSymbol", "LspEnumSymbol", "LspInterfaceSymbol",
    "LspFunctionSymbol", "LspVariableSymbol", "LspConstantSymbol",
    "LspStringSymbol", "LspNumberSymbol", "LspBooleanSymbol", "LspArraySymbol",
    "LspObjectSymbol", "LspKeySymbol", "LspNullSymbol", "LspEnumMemberSymbol",
    "LspStructSymbol", "LspEventSymbol", "LspOperatorSymbol",
    "LspTypeParameterSymbol",
)

class LadybugClient:
    """Python Client to read and query LadybugDB graphs with typed dataclasses."""

    def __init__(self, project_path: str):
        self.input_path = Path(project_path).expanduser().resolve()
        self.db_path = resolve_lbug_path(project_path)
        self.project_path = (
            self.db_path.parent.parent if self.db_path.name == "lbug" else self.db_path.parent
        )
        self.db = ladybug.Database(str(self.db_path), read_only=True)
        self.conn = ladybug.Connection(self.db)
        self.tables = table_catalog(self.conn)
        self.schema = schema_family(self.tables)

    def close(self) -> None:
        closer = getattr(self.conn, "close", None)
        if callable(closer):
            closer()
        closer = getattr(self.db, "close", None)
        if callable(closer):
            closer()

    def __enter__(self) -> "LadybugClient":
        return self

    def __exit__(self, *_: object) -> None:
        self.close()

    def query(self, cypher_query: str, parameters: Optional[Dict[str, Any]] = None) -> List[List[Any]]:
        """Execute a raw Cypher query and return rows as python lists."""
        result = (
            self.conn.execute(cypher_query, parameters=parameters)
            if parameters else self.conn.execute(cypher_query)
        )
        rows = []
        while result.has_next():
            rows.append(result.get_next())
        return rows

    def _require_lsp(self) -> None:
        if self.schema != "lsp-native":
            raise RuntimeError(f"LSP-native operation requested for {self.schema!r} database")

    @staticmethod
    def _range(row: List[Any], offset: int) -> LspRange:
        return LspRange(
            LspPosition(int(row[offset]), int(row[offset + 1])),
            LspPosition(int(row[offset + 2]), int(row[offset + 3])),
        )

    def get_lsp_analysis_runs(self) -> List[LspAnalysisRunNode]:
        self._require_lsp()
        rows = self.query(
            "MATCH (n:LspAnalysisRun) RETURN n.id, n.workspaceUri, n.repositoryPath, "
            "n.protocolVersion, n.positionEncoding, n.status, n.startedAt, n.completedAt, "
            "n.requestedLanguages, n.configurationHash, n.errorCount, n.timeoutCount"
        )
        return [LspAnalysisRunNode(
            id=r[0], workspace_uri=r[1], repository_path=r[2], protocol_version=r[3],
            position_encoding=r[4], status=r[5], started_at=r[6], completed_at=r[7],
            requested_languages=list(r[8] or []), configuration_hash=r[9],
            error_count=int(r[10] or 0), timeout_count=int(r[11] or 0),
        ) for r in rows]

    def get_lsp_build_roots(self) -> List[LspBuildRootNode]:
        self._require_lsp()
        rows = self.query(
            "MATCH (n:LspBuildRoot) RETURN n.id, n.runId, n.workspaceUri, n.repositoryPath, "
            "n.relativePath, n.buildSystems, n.javaMajor, n.importStatus, n.configurationHash, "
            "n.excludedRootIds"
        )
        return [LspBuildRootNode(
            id=r[0], run_id=r[1], workspace_uri=r[2], repository_path=r[3],
            relative_path=r[4], build_systems=list(r[5] or []),
            java_major=int(r[6]) if r[6] is not None else None, import_status=r[7],
            configuration_hash=r[8], excluded_root_ids=list(r[9] or []),
        ) for r in rows]

    def get_lsp_servers(self) -> List[LspServerNode]:
        self._require_lsp()
        rows = self.query(
            "MATCH (n:LspServer) RETURN n.id, n.runId, n.name, n.version, n.languageId, "
            "n.command, n.status, n.capabilitiesJson, n.buildRootId, n.processShardId"
        )
        return [LspServerNode(*r) for r in rows]

    def get_lsp_documents(self) -> List[LspDocumentNode]:
        self._require_lsp()
        rows = self.query(
            "MATCH (n:LspDocument) RETURN n.id, n.uri, n.filePath, n.languageId, n.version, "
            "n.contentHash, n.origin, n.wasOpened, n.buildRootId"
        )
        return [LspDocumentNode(
            id=r[0], uri=r[1], file_path=r[2], language_id=r[3],
            version=int(r[4]) if r[4] is not None else None, content_hash=r[5], origin=r[6],
            was_opened=bool(r[7]), build_root_id=r[8],
        ) for r in rows]

    def get_lsp_symbols(self, kind_name: Optional[str] = None) -> List[LspSymbolNode]:
        """Load symbols from their exact LSP SymbolKind physical tables."""
        self._require_lsp()
        if kind_name:
            requested = f"Lsp{kind_name.removeprefix('Lsp').removesuffix('Symbol')}Symbol"
            tables = (requested,)
        else:
            tables = LSP_SYMBOL_TABLES
        symbols: List[LspSymbolNode] = []
        for table in tables:
            if table not in self.tables:
                continue
            rows = self.query(
                f"MATCH (n:{table}) RETURN n.id, n.documentId, n.uri, n.name, n.detail, "
                "n.kind, n.kindName, n.containerName, n.startLine, n.startCharacter, "
                "n.endLine, n.endCharacter, n.selectionStartLine, n.selectionStartCharacter, "
                "n.selectionEndLine, n.selectionEndCharacter, n.signature, n.stableKey, n.isExternal"
            )
            symbols.extend(LspSymbolNode(
                id=r[0], table=table, document_id=r[1], uri=r[2], name=r[3], detail=r[4],
                kind=int(r[5]), kind_name=r[6], container_name=r[7], range=self._range(r, 8),
                selection_range=self._range(r, 12), signature=r[16], stable_key=r[17],
                is_external=bool(r[18]),
            ) for r in rows)
        return symbols

    def get_lsp_call_sites(self, caller_name: Optional[str] = None) -> List[LspCallSiteNode]:
        """Return calls without collapsing distinct source ranges into one edge."""
        self._require_lsp()
        name_filter = " AND caller.name CONTAINS $callerName" if caller_name else ""
        rows = self.query(
            "MATCH (caller)-[has:LspRelation]->(site:LspCallSite) "
            "WHERE has.kind = 'HAS_CALLSITE'" + name_filter + " "
            "RETURN site.id, site.runId, site.serverId, caller.id, caller.name, "
            "site.documentId, site.capability, site.direction, site.startLine, site.startCharacter, site.endLine, "
            "site.endCharacter, site.calleeName, site.status",
            {"callerName": caller_name} if caller_name else None,
        )
        call_sites = [LspCallSiteNode(
            id=r[0], run_id=r[1], server_id=r[2], caller_id=r[3], caller_name=r[4],
            document_id=r[5], capability=r[6], direction=r[7], range=self._range(r, 8),
            callee_name=r[12], status=r[13],
        ) for r in rows]
        by_id = {site.id: site for site in call_sites}
        if not by_id:
            return call_sites

        resolution_rows = self.query(
            "MATCH (site:LspCallSite)-[resolved:LspRelation]->(callee) "
            "WHERE resolved.kind = 'RESOLVES_TO' "
            "RETURN site.id, callee.id, callee.name, callee.kindName, "
            "resolved.mappingConfidence, resolved.status, resolved.providerAuthority, "
            "resolved.isDerived, resolved.reason"
        )
        for r in resolution_rows:
            site = by_id.get(r[0])
            if site is not None:
                site.resolutions.append(LspCallTarget(
                    id=r[1], name=r[2], kind=r[3], mapping_confidence=float(r[4]),
                    status=r[5], provider_authority=float(r[6]), is_derived=bool(r[7]),
                    reason=r[8],
                ))
        return call_sites

    def get_lsp_occurrences(self, role: Optional[str] = None) -> List[LspOccurrenceNode]:
        self._require_lsp()
        role_filter = " AND occurrence.role = $role" if role else ""
        rows = self.query(
            "MATCH (document:LspDocument)-[contains:LspRelation]->(occurrence:LspOccurrence) "
            "WHERE contains.kind = 'CONTAINS_OCCURRENCE'" + role_filter + " "
            "RETURN occurrence.id, occurrence.runId, occurrence.serverId, occurrence.documentId, "
            "occurrence.capability, occurrence.requestUri, occurrence.requestLine, "
            "occurrence.requestCharacter, occurrence.uri, occurrence.startLine, "
            "occurrence.startCharacter, occurrence.endLine, occurrence.endCharacter, "
            "occurrence.selectionStartLine, occurrence.selectionStartCharacter, "
            "occurrence.selectionEndLine, occurrence.selectionEndCharacter, occurrence.originUri, "
            "occurrence.originStartLine, occurrence.originStartCharacter, occurrence.originEndLine, "
            "occurrence.originEndCharacter, occurrence.role, occurrence.status",
            {"role": role} if role else None,
        )
        occurrences = [LspOccurrenceNode(
            id=r[0], run_id=r[1], server_id=r[2], document_id=r[3], capability=r[4],
            request_uri=r[5], request_position=(
                LspPosition(int(r[6]), int(r[7])) if r[6] is not None else None
            ), uri=r[8], range=self._range(r, 9), selection_range=(
                self._range(r, 13) if r[13] is not None else None
            ), origin_uri=r[17], origin_range=(
                self._range(r, 18) if r[18] is not None else None
            ), role=r[22], status=r[23],
        ) for r in rows]
        by_id = {occurrence.id: occurrence for occurrence in occurrences}
        if not by_id:
            return occurrences
        mapping_rows = self.query(
            "MATCH (occurrence:LspOccurrence)-[mapping:LspRelation]->(target) "
            "RETURN occurrence.id, target.id, target.name, mapping.kind, mapping.mappingConfidence, "
            "mapping.status, mapping.providerAuthority, mapping.isDerived, mapping.reason"
        )
        for r in mapping_rows:
            occurrence = by_id.get(r[0])
            if occurrence is not None:
                occurrence.mappings.append(LspOccurrenceMapping(
                    target_id=r[1], target_name=r[2], relation_kind=r[3],
                    mapping_confidence=float(r[4]), status=r[5], provider_authority=float(r[6]),
                    is_derived=bool(r[7]), reason=r[8],
                ))
        return occurrences

    def get_lsp_coverage(self) -> List[LspCoverageNode]:
        self._require_lsp()
        rows = self.query(
            "MATCH (n:LspCoverage) RETURN n.id, n.runId, n.serverId, n.documentId, "
            "n.languageId, n.capability, n.status, n.eligibleCount, n.attemptedCount, "
            "n.successCount, n.emptyCount, n.failureCount, n.timeoutCount, n.resultCount, "
            "n.mappedCount, n.externalCount, n.unmappedCount, n.exclusionReason"
        )
        return [LspCoverageNode(
            id=r[0], run_id=r[1], server_id=r[2], document_id=r[3], language_id=r[4],
            capability=r[5], status=r[6], eligible_count=int(r[7] or 0),
            attempted_count=int(r[8] or 0), success_count=int(r[9] or 0),
            empty_count=int(r[10] or 0), failure_count=int(r[11] or 0),
            timeout_count=int(r[12] or 0), result_count=int(r[13] or 0),
            mapped_count=int(r[14] or 0), external_count=int(r[15] or 0),
            unmapped_count=int(r[16] or 0), exclusion_reason=r[17],
        ) for r in rows]

    def get_lsp_diagnostics(self) -> List[LspDiagnosticNode]:
        self._require_lsp()
        rows = self.query(
            "MATCH (n:LspDiagnostic) RETURN n.id, n.runId, n.serverId, n.documentId, "
            "n.capability, n.startLine, n.startCharacter, n.endLine, n.endCharacter, "
            "n.severity, n.code, n.codeHref, n.source, n.message, n.tags, "
            "n.relatedInformationJson, n.status"
        )
        return [LspDiagnosticNode(
            id=r[0], run_id=r[1], server_id=r[2], document_id=r[3], capability=r[4],
            range=self._range(r, 5), severity=int(r[9]) if r[9] is not None else None,
            code=r[10], code_href=r[11], source=r[12], message=r[13],
            tags=list(r[14] or []), related_information_json=r[15], status=r[16],
        ) for r in rows]

    def get_lsp_hovers(self) -> List[LspHoverNode]:
        self._require_lsp()
        rows = self.query(
            "MATCH (n:LspHover) RETURN n.id, n.runId, n.serverId, n.documentId, n.capability, "
            "n.requestLine, n.requestCharacter, n.startLine, n.startCharacter, n.endLine, "
            "n.endCharacter, n.contentFormat, n.contents, n.status"
        )
        return [LspHoverNode(
            id=r[0], run_id=r[1], server_id=r[2], document_id=r[3], capability=r[4],
            request_position=LspPosition(int(r[5]), int(r[6])),
            range=self._range(r, 7) if r[7] is not None else None,
            content_format=r[11], contents=r[12], status=r[13],
        ) for r in rows]

    def get_lsp_semantic_tokens(self) -> List[LspSemanticTokenNode]:
        self._require_lsp()
        rows = self.query(
            "MATCH (n:LspSemanticToken) RETURN n.id, n.runId, n.serverId, n.documentId, "
            "n.capability, n.line, n.character, n.length, n.tokenType, n.tokenModifiers, n.status"
        )
        return [LspSemanticTokenNode(
            id=r[0], run_id=r[1], server_id=r[2], document_id=r[3], capability=r[4],
            line=int(r[5]), character=int(r[6]), length=int(r[7]), token_type=r[8],
            token_modifiers=list(r[9] or []), status=r[10],
        ) for r in rows]

    def get_lsp_signature_helps(self) -> List[LspSignatureHelpNode]:
        self._require_lsp()
        rows = self.query(
            "MATCH (n:LspSignatureHelp) RETURN n.id, n.runId, n.serverId, n.documentId, "
            "n.capability, n.requestLine, n.requestCharacter, n.activeSignature, "
            "n.activeParameter, n.status"
        )
        return [LspSignatureHelpNode(
            id=r[0], run_id=r[1], server_id=r[2], document_id=r[3], capability=r[4],
            request_position=LspPosition(int(r[5]), int(r[6])),
            active_signature=int(r[7]) if r[7] is not None else None,
            active_parameter=int(r[8]) if r[8] is not None else None, status=r[9],
        ) for r in rows]

    def get_lsp_signatures(self) -> List[LspSignatureNode]:
        self._require_lsp()
        rows = self.query(
            "MATCH (n:LspSignature) RETURN n.id, n.signatureHelpId, n.label, n.documentation, "
            "n.activeParameter, n.ordinal"
        )
        return [LspSignatureNode(
            id=r[0], signature_help_id=r[1], label=r[2], documentation=r[3],
            active_parameter=int(r[4]) if r[4] is not None else None, ordinal=int(r[5]),
        ) for r in rows]

    def get_lsp_parameters(self) -> List[LspParameterNode]:
        self._require_lsp()
        rows = self.query(
            "MATCH (n:LspParameter) RETURN n.id, n.signatureId, n.label, n.labelStart, "
            "n.labelEnd, n.documentation, n.ordinal"
        )
        return [LspParameterNode(
            id=r[0], signature_id=r[1], label=r[2],
            label_start=int(r[3]) if r[3] is not None else None,
            label_end=int(r[4]) if r[4] is not None else None,
            documentation=r[5], ordinal=int(r[6]),
        ) for r in rows]

    def get_lsp_relations(self, kind: Optional[str] = None) -> List[LspRelationRecord]:
        self._require_lsp()
        kind_filter = " WHERE r.kind = $kind" if kind else ""
        rows = self.query(
            "MATCH (source)-[r:LspRelation]->(target)" + kind_filter + " "
            "RETURN source.id, target.id, r.id, r.kind, r.runId, r.serverId, r.capability, "
            "r.status, r.providerAuthority, r.mappingConfidence, r.isDerived, r.reason, r.ordinal",
            {"kind": kind} if kind else None,
        )
        return [LspRelationRecord(
            source_id=r[0], target_id=r[1], id=r[2], kind=r[3], run_id=r[4],
            server_id=r[5], capability=r[6], status=r[7], provider_authority=float(r[8]),
            mapping_confidence=float(r[9]), is_derived=bool(r[10]), reason=r[11], ordinal=r[12],
        ) for r in rows]

    def get_jvm_artifacts(self) -> List[JvmArtifactNode]:
        if "JvmArtifact" not in self.tables:
            return []
        rows = self.query(
            "MATCH (n:JvmArtifact) RETURN n.id, n.stageId, n.buildRootIds, n.classpathProviders, "
            "n.classpathScopes, n.modulePath, n.coordinate, n.classpathEntryPath, n.headerJarPath, "
            "n.binaryJarPath, n.sourceJarPath, n.sourceOrigin, n.associationStatus, n.classCount"
        )
        return [JvmArtifactNode(
            id=r[0], stage_id=r[1], build_root_ids=list(r[2] or []),
            classpath_providers=list(r[3] or []), classpath_scopes=list(r[4] or []),
            module_path=bool(r[5]), coordinate=r[6], classpath_entry_path=r[7],
            header_jar_path=r[8], binary_jar_path=r[9], source_jar_path=r[10],
            source_origin=r[11], association_status=r[12], class_count=int(r[13] or 0),
        ) for r in rows]

    def get_jvm_classes(self, name: Optional[str] = None) -> List[JvmClassNode]:
        if "JvmClass" not in self.tables:
            return []
        name_filter = " WHERE n.binaryName CONTAINS $name" if name else ""
        rows = self.query(
            "MATCH (n:JvmClass)" + name_filter + " RETURN n.id, n.stageId, n.artifactId, "
            "n.binaryName, n.packageName, n.simpleName, n.kind, n.access, n.superName, "
            "n.interfaces, n.sourceEntry, n.isSeed, n.seedUris, n.wasDisassembled, n.annotations",
            {"name": name} if name else None,
        )
        return [JvmClassNode(
            id=r[0], stage_id=r[1], artifact_id=r[2], binary_name=r[3], package_name=r[4],
            simple_name=r[5], kind=r[6], access=r[7], super_name=r[8],
            interfaces=list(r[9] or []), source_entry=r[10], is_seed=bool(r[11]),
            seed_uris=list(r[12] or []), was_disassembled=bool(r[13]),
            annotations=list(r[14] or []),
        ) for r in rows]

    def get_jvm_enrichment_runs(self) -> List[JvmArtifactEnrichmentRunNode]:
        if "JvmArtifactEnrichmentRun" not in self.tables:
            return []
        rows = self.query(
            "MATCH (n:JvmArtifactEnrichmentRun) RETURN n.id, n.lspRunId, n.status, n.startedAt, "
            "n.completedAt, n.provider, n.providerVersion, n.classpathProviders, "
            "n.classpathResolutionJson, n.classpathErrorCount, n.artifactCount, n.classCount, "
            "n.methodCount, n.fieldCount, n.callSiteCount, n.errorCount, n.truncated"
        )
        return [JvmArtifactEnrichmentRunNode(
            id=r[0], lsp_run_id=r[1], status=r[2], started_at=r[3], completed_at=r[4],
            provider=r[5], provider_version=r[6], classpath_providers=list(r[7] or []),
            classpath_resolution_json=r[8], classpath_error_count=int(r[9] or 0),
            artifact_count=int(r[10] or 0), class_count=int(r[11] or 0),
            method_count=int(r[12] or 0), field_count=int(r[13] or 0),
            call_site_count=int(r[14] or 0), error_count=int(r[15] or 0), truncated=bool(r[16]),
        ) for r in rows]

    def get_jvm_methods(self) -> List[JvmMethodNode]:
        if "JvmMethod" not in self.tables:
            return []
        rows = self.query(
            "MATCH (n:JvmMethod) RETURN n.id, n.stageId, n.classId, n.owner, n.name, "
            "n.descriptor, n.declaration, n.access, n.hasCode, n.isExternalPlaceholder, "
            "n.annotations"
        )
        return [JvmMethodNode(
            id=r[0], stage_id=r[1], class_id=r[2], owner=r[3], name=r[4], descriptor=r[5],
            declaration=r[6], access=r[7], has_code=bool(r[8]),
            is_external_placeholder=bool(r[9]), annotations=list(r[10] or []),
        ) for r in rows]

    def get_jvm_fields(self) -> List[JvmFieldNode]:
        if "JvmField" not in self.tables:
            return []
        rows = self.query(
            "MATCH (n:JvmField) RETURN n.id, n.stageId, n.classId, n.owner, n.name, "
            "n.descriptor, n.declaration, n.access, n.annotations"
        )
        return [JvmFieldNode(*r[:8], annotations=list(r[8] or [])) for r in rows]

    def get_jvm_call_sites(self) -> List[JvmCallSiteNode]:
        if "JvmCallSite" not in self.tables:
            return []
        rows = self.query(
            "MATCH (n:JvmCallSite) RETURN n.id, n.stageId, n.callerMethodId, n.bytecodeOffset, "
            "n.opcode, n.targetOwner, n.targetName, n.targetDescriptor, n.status"
        )
        return [JvmCallSiteNode(
            id=r[0], stage_id=r[1], caller_method_id=r[2], bytecode_offset=int(r[3]),
            opcode=r[4], target_owner=r[5], target_name=r[6], target_descriptor=r[7], status=r[8],
        ) for r in rows]

    def get_jvm_relations(self, kind: Optional[str] = None) -> List[JvmRelationRecord]:
        if "JvmRelation" not in self.tables:
            return []
        kind_filter = " WHERE r.kind = $kind" if kind else ""
        rows = self.query(
            "MATCH (source)-[r:JvmRelation]->(target)" + kind_filter + " "
            "RETURN source.id, target.id, r.id, r.kind, r.stageId, r.status, r.ordinal",
            {"kind": kind} if kind else None,
        )
        return [JvmRelationRecord(
            source_id=r[0], target_id=r[1], id=r[2], kind=r[3], stage_id=r[4],
            status=r[5], ordinal=r[6],
        ) for r in rows]

    def get_lsp_jvm_bindings(self, kind: Optional[str] = None) -> List[LspJvmBindingRecord]:
        if "LspJvmBinding" not in self.tables:
            return []
        kind_filter = " WHERE binding.kind = $kind" if kind else ""
        rows = self.query(
            "MATCH (source)-[binding:LspJvmBinding]->(target)" + kind_filter + " "
            "RETURN source.id, target.id, binding.id, binding.kind, binding.stageId, "
            "binding.status, binding.confidence, binding.reason",
            {"kind": kind} if kind else None,
        )
        return [LspJvmBindingRecord(
            source_id=r[0], target_id=r[1], id=r[2], kind=r[3], stage_id=r[4],
            status=r[5], confidence=float(r[6]), reason=r[7],
        ) for r in rows]

    def get_call_normalization_runs(self) -> List[DerivedCallNormalizationRunNode]:
        if "DerivedCallNormalizationRun" not in self.tables:
            return []
        rows = self.query(
            "MATCH (n:DerivedCallNormalizationRun) RETURN n.id, n.lspRunId, n.status, "
            "n.algorithmVersion, n.startedAt, n.completedAt, n.observationCount, "
            "n.invocationCount, n.normalizedObservationCount, "
            "n.ambiguousObservationCount, n.errorCount"
        )
        return [DerivedCallNormalizationRunNode(
            id=r[0], lsp_run_id=r[1], status=r[2], algorithm_version=r[3],
            started_at=r[4], completed_at=r[5], observation_count=int(r[6]),
            invocation_count=int(r[7]), normalized_observation_count=int(r[8]),
            ambiguous_observation_count=int(r[9]), error_count=int(r[10]),
        ) for r in rows]

    def get_logical_invocations(self) -> List[LspLogicalInvocationNode]:
        if "LspLogicalInvocation" not in self.tables:
            return []
        rows = self.query(
            "MATCH (n:LspLogicalInvocation) RETURN n.id, n.stageId, n.runId, n.documentId, "
            "n.callerSymbolId, n.callerStableKey, n.targetFamilyId, n.targetFamilyStableKey, "
            "n.canonicalTargetId, n.canonicalTargetKind, n.startLine, n.startCharacter, "
            "n.endLine, n.endCharacter, n.observationCount, n.directions, n.capabilities, "
            "n.stableKey, n.status, n.confidence, n.algorithmVersion"
        )
        return [LspLogicalInvocationNode(
            id=r[0], stage_id=r[1], run_id=r[2], document_id=r[3],
            caller_symbol_id=r[4], caller_stable_key=r[5], target_family_id=r[6],
            target_family_stable_key=r[7], canonical_target_id=r[8],
            canonical_target_kind=r[9],
            range=LspRange(
                start=LspPosition(line=int(r[10]), character=int(r[11])),
                end=LspPosition(line=int(r[12]), character=int(r[13])),
            ),
            observation_count=int(r[14]), directions=list(r[15] or []),
            capabilities=list(r[16] or []), stable_key=r[17], status=r[18],
            confidence=float(r[19]), algorithm_version=r[20],
        ) for r in rows]

    def get_derived_call_relations(
        self, kind: Optional[str] = None,
    ) -> List[DerivedCallRelationRecord]:
        if "DerivedCallRelation" not in self.tables:
            return []
        kind_filter = " WHERE relation.kind = $kind" if kind else ""
        rows = self.query(
            "MATCH (source)-[relation:DerivedCallRelation]->(target)" + kind_filter + " "
            "RETURN source.id, target.id, relation.id, relation.kind, relation.stageId, "
            "relation.confidence, relation.ordinal",
            {"kind": kind} if kind else None,
        )
        return [DerivedCallRelationRecord(
            source_id=r[0], target_id=r[1], id=r[2], kind=r[3], stage_id=r[4],
            confidence=float(r[5]), ordinal=int(r[6]),
        ) for r in rows]

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
    with LadybugClient(target) as client:
        print("=" * 64)
        print("🐍 PYTHON LADYBUGDB CLIENT & TYPED DATA CLASSES")
        print(f"   Database: {client.db_path}")
        print(f"   Schema:   {client.schema}")
        print("=" * 64)

        if client.schema == "lsp-native":
            runs = client.get_lsp_analysis_runs()
            roots = client.get_lsp_build_roots()
            servers = client.get_lsp_servers()
            documents = client.get_lsp_documents()
            symbols = client.get_lsp_symbols()
            calls = client.get_lsp_call_sites()
            coverage = client.get_lsp_coverage()
            artifacts = client.get_jvm_artifacts()
            print(f"   LspAnalysisRunNode: {len(runs)}")
            print(f"   LspBuildRootNode:   {len(roots)}")
            print(f"   LspServerNode:      {len(servers)}")
            print(f"   LspDocumentNode:    {len(documents)}")
            print(f"   LspSymbolNode:      {len(symbols)}")
            print(f"   LspCallSiteNode:    {len(calls)}")
            print(f"   LspCoverageNode:    {len(coverage)}")
            print(f"   JvmArtifactNode:    {len(artifacts)}")
            if runs:
                run = runs[0]
                print(f"\n   Run status: {run.status}; errors={run.error_count}; timeouts={run.timeout_count}")
            if calls:
                call = calls[0]
                target_name = call.resolutions[0].name if call.resolutions else call.callee_name
                print(
                    f"   Sample call: {call.caller_name} @ "
                    f"{call.range.start.line}:{call.range.start.character} -> "
                    f"{target_name or '(unresolved)'}"
                )
        else:
            classes = client.get_classes()
            methods = client.get_methods()
            routes = client.get_routes()
            processes = client.get_processes()
            calls = client.get_relations(rel_type="CALLS")
            print(f"   ClassNode:    {len(classes)}")
            print(f"   MethodNode:   {len(methods)}")
            print(f"   RouteNode:    {len(routes)}")
            print(f"   ProcessNode:  {len(processes)}")
            print(f"   CALLS edges:  {len(calls)}")

        print("\n✅ Python Ladybug client read passed")

if __name__ == "__main__":
    main()
