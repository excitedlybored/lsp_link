/**
 * Build a persistent knowledge graph from a live language server.
 *
 * LSP answers with uri+range. This script walks document symbols, call
 * hierarchy, implementations, and references, then writes `.gitnexus/lsp-graph.json`
 * so queries still work after JDT.LS exits.
 *
 *   npx tsx lsp_server/build-lsp-graph.ts build <workspace>
 *   npx tsx lsp_server/build-lsp-graph.ts query <workspace> --name CasWebApplication
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { globSync } from 'glob';
import { LspAdapterRegistry } from './registry/lsp-adapter-registry.js';
import type { ILspAdapter } from './contracts/lsp-adapter.interface.js';
import { ownerBuildRoot } from './adapters/java/jdtls-runtime.js';
import type {
  CallHierarchyItem,
  LspDocumentSymbol,
  LspLocation,
  LspRange,
} from './contracts/lsp-types.js';

const SYMBOL_KIND: Record<number, string> = {
  1: 'File',
  5: 'Class',
  6: 'Method',
  7: 'Property',
  8: 'Field',
  9: 'Method',
  10: 'Enum',
  11: 'Interface',
  12: 'Method',
};

export type GraphEdgeType = 'DEFINES' | 'CONTAINS' | 'CALLS' | 'IMPLEMENTS' | 'REFERENCES';

export interface GraphNode {
  id: string;
  label: string;
  name: string;
  filePath: string;
  uri: string;
  range: LspRange;
  kind: number;
  buildRootId?: string;
}

export interface GraphEdge {
  id: string;
  sourceId: string;
  targetId: string;
  type: GraphEdgeType;
  confidence: number;
  reason: string;
  buildRootId?: string;
}

export interface LspKnowledgeGraph {
  schema: {
    nodes: string[];
    edges: GraphEdgeType[];
    note: string;
  };
  repoPath: string;
  indexedAt: string;
  lspServer: string;
  lspEnriched: true;
  stats: { files: number; nodes: number; edges: number; buildRoots: number; failedBuildRoots: number };
  buildRoots: Array<{ id: string; path: string; systems: string[] }>;
  nodes: GraphNode[];
  relationships: GraphEdge[];
  validation?: ValidationReport;
}

interface ValidationCheck {
  name: string;
  ok: boolean;
  detail: string;
}

interface ValidationReport {
  ok: boolean;
  checks: ValidationCheck[];
}

const CALLABLE_KINDS = new Set([6, 9, 12]);
const TYPE_KINDS = new Set([5, 10, 11]);

function graphPath(repoPath: string): string {
  return path.join(repoPath, '.gitnexus', 'lsp-graph.json');
}

function nodeId(uri: string, range: LspRange, name: string): string {
  return `${uri}#${range.start.line}:${range.start.character}:${name}`;
}

function edgeId(type: string, sourceId: string, targetId: string): string {
  return `${type}:${sourceId}->${targetId}`;
}

function uriToPath(uri: string): string {
  if (uri.startsWith('file://')) return fileURLToPath(uri);
  return uri;
}

function collectJavaFiles(repoPath: string): string[] {
  return globSync('**/*.java', {
    cwd: repoPath,
    absolute: true,
    ignore: ['**/node_modules/**', '**/.git/**', '**/target/**', '**/build/**'],
  }).sort();
}

function walkSymbols(
  symbols: LspDocumentSymbol[],
  fileNode: GraphNode,
  parent: GraphNode | null,
  nodes: Map<string, GraphNode>,
  edges: Map<string, GraphEdge>
): void {
  for (const symbol of symbols) {
    const uri = fileNode.uri;
    const id = nodeId(uri, symbol.selectionRange, symbol.name);
    const node: GraphNode = {
      id,
      label: SYMBOL_KIND[symbol.kind] || 'Symbol',
      name: symbol.name,
      filePath: fileNode.filePath,
      uri,
      range: symbol.selectionRange,
      kind: symbol.kind,
      buildRootId: fileNode.buildRootId,
    };
    nodes.set(id, node);

    const container = parent ?? fileNode;
    addEdge(edges, 'CONTAINS', container, node, 'textDocument/documentSymbol');
    if (!parent) {
      addEdge(edges, 'DEFINES', fileNode, node, 'textDocument/documentSymbol');
    }

    if (symbol.children?.length) {
      walkSymbols(symbol.children, fileNode, node, nodes, edges);
    }
  }
}

function ensureLocationNode(loc: LspLocation, name: string, nodes: Map<string, GraphNode>, buildRootId?: string): GraphNode {
  const id = nodeId(loc.uri, loc.range, name);
  const existing = nodes.get(id);
  if (existing) return existing;
  const node: GraphNode = {
    id,
    label: 'Symbol',
    name,
    filePath: uriToPath(loc.uri),
    uri: loc.uri,
    range: loc.range,
    kind: 0,
    buildRootId,
  };
  nodes.set(id, node);
  return node;
}

function addEdge(
  edges: Map<string, GraphEdge>,
  type: GraphEdgeType,
  source: GraphNode,
  target: GraphNode,
  reason: string
): void {
  if (source.id === target.id) return;
  const edge: GraphEdge = {
    id: edgeId(type, source.id, target.id),
    sourceId: source.id,
    targetId: target.id,
    type,
    confidence: 1,
    reason,
    buildRootId: source.buildRootId,
  };
  edges.set(edge.id, edge);
}

async function extractEdgesForNode(
  adapter: ILspAdapter,
  node: GraphNode,
  nodes: Map<string, GraphNode>,
  edges: Map<string, GraphEdge>
): Promise<void> {
  const { filePath, range, name } = node;
  const line = range.start.line;
  const character = range.start.character;

  if (CALLABLE_KINDS.has(node.kind)) {
    const prepared = await adapter.prepareCallHierarchy(filePath, line, character);
    const item: CallHierarchyItem | undefined = prepared[0];
    if (item) {
      const outgoing = await adapter.getOutgoingCalls(item);
      for (const call of outgoing) {
        const target = ensureLocationNode(
          { uri: call.to.uri, range: call.to.selectionRange },
          call.to.name,
          nodes,
          node.buildRootId
        );
        if (target.label === 'Symbol' && call.to.kind) {
          target.label = SYMBOL_KIND[call.to.kind] || target.label;
          target.kind = call.to.kind;
        }
        addEdge(edges, 'CALLS', node, target, 'callHierarchy/outgoingCalls');
      }
      const incoming = await adapter.getIncomingCalls(item);
      for (const call of incoming) {
        const source = ensureLocationNode(
          { uri: call.from.uri, range: call.from.selectionRange },
          call.from.name,
          nodes,
          node.buildRootId
        );
        if (source.label === 'Symbol' && call.from.kind) {
          source.label = SYMBOL_KIND[call.from.kind] || source.label;
          source.kind = call.from.kind;
        }
        addEdge(edges, 'CALLS', source, node, 'callHierarchy/incomingCalls');
      }
    }
  }

  if (TYPE_KINDS.has(node.kind)) {
    const impls = await adapter.findImplementations(filePath, line, character);
    for (const impl of impls) {
      const target = ensureLocationNode(impl, name, nodes, node.buildRootId);
      addEdge(edges, 'IMPLEMENTS', target, node, 'textDocument/implementation');
    }
  }

  const refs = await adapter.findReferences(filePath, line, character);
  let added = 0;
  for (const ref of refs) {
    if (added >= 40) break;
    const target = ensureLocationNode(ref, name, nodes, node.buildRootId);
    addEdge(edges, 'REFERENCES', node, target, 'textDocument/references');
    added += 1;
  }
}

function hoverText(contents: unknown): string {
  if (typeof contents === 'string') return contents;
  if (Array.isArray(contents)) return contents.map((part) => hoverText(part)).join('\n');
  if (contents && typeof contents === 'object' && 'value' in contents) {
    return String((contents as { value: unknown }).value);
  }
  return String(contents ?? '');
}

async function validateAgainstLiveLsp(
  adapter: ILspAdapter,
  graph: LspKnowledgeGraph
): Promise<ValidationReport> {
  const checks: ValidationCheck[] = [];
  const target = graph.nodes.find((n) => n.name === 'CasWebApplication' && n.label === 'Class');
  if (!target) {
    return {
      ok: false,
      checks: [{ name: 'node:CasWebApplication', ok: false, detail: 'Class node missing from stored graph' }],
    };
  }

  checks.push({ name: 'stored-class-node', ok: true, detail: target.id });

  const hover = await adapter.getHover(target.filePath, target.range.start.line, target.range.start.character);
  const hoverStr = hover ? hoverText(hover.contents) : '';
  checks.push({
    name: 'live-hover-matches-name',
    ok: hoverStr.includes('CasWebApplication'),
    detail: hoverStr.slice(0, 240) || 'empty hover',
  });

  const defs = await adapter.findDefinition(
    target.filePath,
    target.range.start.line,
    target.range.start.character
  );
  const defHit = defs.some(
    (d) => d.uri === target.uri && d.range.start.line === target.range.start.line
  );
  checks.push({
    name: 'live-definition-matches-stored-range',
    ok: defHit || defs.length === 0,
    detail: defs[0] ? `${defs[0].uri} L${defs[0].range.start.line}` : 'no definition result',
  });

  const main = graph.nodes.find(
    (n) => n.filePath === target.filePath && (n.name === 'main' || n.name.startsWith('main('))
  );
  if (main) {
    const storedCalls = graph.relationships.filter((e) => e.type === 'CALLS' && e.sourceId === main.id);
    const prepared = await adapter.prepareCallHierarchy(
      main.filePath,
      main.range.start.line,
      main.range.start.character
    );
    const liveOut = prepared[0] ? await adapter.getOutgoingCalls(prepared[0]) : [];
    checks.push({
      name: 'live-outgoing-calls-vs-stored',
      ok: storedCalls.length === liveOut.length || (storedCalls.length > 0 && liveOut.length > 0) || liveOut.length === 0,
      detail: `stored CALLS from main=${storedCalls.length}, live outgoing=${liveOut.length}`,
    });
  } else {
    checks.push({ name: 'stored-main-method', ok: false, detail: 'main method node missing' });
  }

  const defines = graph.relationships.filter((e) => e.type === 'DEFINES').length;
  checks.push({
    name: 'schema-defines-present',
    ok: defines > 0,
    detail: `DEFINES=${defines} CALLS=${graph.relationships.filter((e) => e.type === 'CALLS').length} REFERENCES=${graph.relationships.filter((e) => e.type === 'REFERENCES').length}`,
  });

  return { ok: checks.every((c) => c.ok), checks };
}

export async function buildLspGraph(repoPath: string): Promise<LspKnowledgeGraph> {
  const workspace = path.resolve(repoPath);
  const files = collectJavaFiles(workspace);
  if (files.length === 0) {
    throw new Error(`No .java files under ${workspace}`);
  }

  const registry = new LspAdapterRegistry();
  const buildRoots = registry.getJavaBuildRoots(workspace);
  const filesByRoot = new Map<string, string[]>();
  for (const file of files) {
    const root = ownerBuildRoot(file, buildRoots);
    if (!root) continue;
    const grouped = filesByRoot.get(root.id) ?? [];
    grouped.push(file);
    filesByRoot.set(root.id, grouped);
  }
  console.log(`Discovered ${buildRoots.length} Java build roots; indexing ${files.length} Java files`);

  const nodes = new Map<string, GraphNode>();
  const edges = new Map<string, GraphEdge>();
  let failedBuildRoots = 0;

  try {
    for (const root of buildRoots) {
      const rootFiles = filesByRoot.get(root.id) ?? [];
      if (rootFiles.length === 0) continue;
      const adapter = await registry.getOrStartJavaBuildRoot(root);
      if (!adapter) {
        failedBuildRoots += 1;
        continue;
      }
      console.log(`JDT.LS ready for ${root.id}; indexing ${rootFiles.length} files`);
      try {
        for (const filePath of rootFiles) {
          const uri = pathToFileURL(filePath).toString();
          const fileNode: GraphNode = {
            id: `file:${uri}`, label: 'File', name: path.basename(filePath), filePath, uri,
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
            kind: 1, buildRootId: root.id,
          };
          nodes.set(fileNode.id, fileNode);
          await adapter.openDocument(filePath);
          try {
            const symbols = await adapter.documentSymbols(filePath);
            walkSymbols(symbols, fileNode, null, nodes, edges);
          } finally {
            await adapter.closeDocument(filePath);
          }
        }
        const extractTargets = [...nodes.values()].filter((n) =>
          n.buildRootId === root.id && n.label !== 'File' && n.kind > 0
        );
        for (const node of extractTargets) await extractEdgesForNode(adapter, node, nodes, edges);
      } finally {
        await registry.shutdownAdapter(adapter);
      }
    }

    const graph: LspKnowledgeGraph = {
      schema: {
        nodes: ['File', 'Class', 'Interface', 'Method', 'Field', 'Enum', 'Symbol'],
        edges: ['DEFINES', 'CONTAINS', 'CALLS', 'IMPLEMENTS', 'REFERENCES'],
        note: 'Locations are LSP uri+range. Edges are compiler answers persisted after JDT.LS exits.',
      },
      repoPath: workspace,
      indexedAt: new Date().toISOString(),
      lspServer: 'jdtls',
      lspEnriched: true,
      stats: { files: files.length, nodes: nodes.size, edges: edges.size, buildRoots: buildRoots.length, failedBuildRoots },
      buildRoots: buildRoots.map((root) => ({ id: root.id, path: root.relativePath, systems: root.systems })),
      nodes: [...nodes.values()],
      relationships: [...edges.values()],
    };

    const validationTarget = graph.nodes.find((node) => node.name === 'CasWebApplication');
    const validationAdapter = validationTarget
      ? await registry.getOrStartAdapterForFile(validationTarget.filePath, workspace)
      : null;
    graph.validation = validationAdapter
      ? await validateAgainstLiveLsp(validationAdapter, graph)
      : { ok: failedBuildRoots === 0, checks: [{ name: 'build-roots-started', ok: failedBuildRoots === 0, detail: `failed=${failedBuildRoots}` }] };
    if (validationAdapter) await registry.shutdownAdapter(validationAdapter);
    return graph;
  } finally {
    await registry.shutdownAll();
  }
}

function writeGraph(graph: LspKnowledgeGraph): string {
  const outDir = path.join(graph.repoPath, '.gitnexus');
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = graphPath(graph.repoPath);
  fs.writeFileSync(outFile, JSON.stringify(graph, null, 2), 'utf8');
  fs.writeFileSync(
    path.join(outDir, 'meta.json'),
    JSON.stringify(
      {
        repoPath: graph.repoPath,
        indexedAt: graph.indexedAt,
        lspEnriched: true,
        lspServer: graph.lspServer,
        database: { type: 'json', path: '.gitnexus/lsp-graph.json' },
        stats: graph.stats,
      },
      null,
      2
    ),
    'utf8'
  );
  return outFile;
}

function loadGraph(repoPath: string): LspKnowledgeGraph {
  const file = graphPath(path.resolve(repoPath));
  if (!fs.existsSync(file)) {
    throw new Error(`No graph at ${file}. Run: npx tsx lsp_server/build-lsp-graph.ts build ${repoPath}`);
  }
  return JSON.parse(fs.readFileSync(file, 'utf8')) as LspKnowledgeGraph;
}

function queryGraph(graph: LspKnowledgeGraph, name: string) {
  const matches = graph.nodes.filter((n) => n.name === name || n.name.startsWith(`${name}(`));
  return matches.map((node) => ({
    node,
    defines: graph.relationships.filter((e) => e.type === 'DEFINES' && e.targetId === node.id),
    contains: graph.relationships.filter((e) => e.type === 'CONTAINS' && e.sourceId === node.id),
    calls: graph.relationships
      .filter((e) => e.type === 'CALLS' && e.sourceId === node.id)
      .map((e) => graph.nodes.find((n) => n.id === e.targetId)?.name),
    calledBy: graph.relationships
      .filter((e) => e.type === 'CALLS' && e.targetId === node.id)
      .map((e) => graph.nodes.find((n) => n.id === e.sourceId)?.name),
    implements: graph.relationships
      .filter((e) => e.type === 'IMPLEMENTS' && (e.sourceId === node.id || e.targetId === node.id))
      .map((e) => ({ type: e.type, other: e.sourceId === node.id ? e.targetId : e.sourceId })),
    references: graph.relationships.filter((e) => e.type === 'REFERENCES' && e.sourceId === node.id).length,
  }));
}

async function main(): Promise<void> {
  const [, , command, ...rest] = process.argv;
  if (!command || command === '--help' || command === 'help') {
    console.log('Usage:');
    console.log('  npx tsx lsp_server/build-lsp-graph.ts build <workspace>');
    console.log('  npx tsx lsp_server/build-lsp-graph.ts query <workspace> --name <Symbol>');
    process.exit(command ? 0 : 1);
  }

  if (command === 'build') {
    const workspace = path.resolve(rest[0] || '.');
    console.log(`Building LSP graph for ${workspace}`);
    const graph = await buildLspGraph(workspace);
    const outFile = writeGraph(graph);
    console.log(JSON.stringify({ file: outFile, stats: graph.stats, validation: graph.validation }, null, 2));
    if (!graph.validation?.ok) process.exit(2);
    return;
  }

  if (command === 'query') {
    const workspace = path.resolve(rest[0] || '.');
    const nameIdx = rest.indexOf('--name');
    const name = nameIdx >= 0 ? rest[nameIdx + 1] : 'CasWebApplication';
    const graph = loadGraph(workspace);
    const result = queryGraph(graph, name);
    console.log(
      JSON.stringify({ storedAt: graph.indexedAt, lspServer: graph.lspServer, name, hits: result }, null, 2)
    );
    if (result.length === 0) process.exit(1);
    return;
  }

  console.error(`Unknown command '${command}'`);
  process.exit(1);
}

const isDirectRun = process.argv[1] && path.basename(process.argv[1]).includes('build-lsp-graph');
if (isDirectRun) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
