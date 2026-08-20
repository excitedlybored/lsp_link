/**
 * Standardized LSP Query Engine & CLI.
 *
 * Provides a unified query interface for LSP operations:
 *   - calls    : Outgoing / incoming call hierarchy
 *   - impl     : Interface to concrete implementation lookup
 *   - hover    : Type definitions & doc hover
 *   - context  : 360-degree compiler symbol context
 *
 * Automatically resolves symbol names to file coordinates.
 */

import * as path from 'path';
import * as fs from 'fs';
import { globSync } from 'glob';
import { LspAdapterRegistry } from './registry/lsp-adapter-registry.js';
import { ILspAdapter } from './contracts/lsp-adapter.interface.js';

interface SymbolLocation {
  filePath: string;
  line: number;
  character: number;
  containerName?: string;
  kind?: string;
}

/**
 * Scans Java source files to resolve a symbol name to its file location.
 */
function findSymbolInWorkspace(workspacePath: string, symbolName: string): SymbolLocation | null {
  const javaFiles = globSync('src/**/*.java', { cwd: workspacePath });

  let bestMatch: SymbolLocation | null = null;
  let highestScore = 0;

  for (const relFile of javaFiles) {
    const fullPath = path.join(workspacePath, relFile);
    const lines = fs.readFileSync(fullPath, 'utf-8').split('\n');

    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      const line = lines[lineIdx];
      const trimmed = line.trim();

      if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('import ')) {
        continue;
      }

      const regex = new RegExp(`\\b${symbolName}\\b`);
      const match = regex.exec(line);

      if (match) {
        let score = 1;
        // Prioritize definition patterns
        if (new RegExp(`(public|protected|private)?\\s+(interface|class|enum|record)\\s+${symbolName}\\b`).test(trimmed)) {
          score = 100;
        } else if (new RegExp(`(public|protected|private)?\\s+[\\w<>\\[\\]]+\\s+${symbolName}\\s*\\(`).test(trimmed)) {
          score = 80;
        } else if (trimmed.includes(`class ${symbolName}`) || trimmed.includes(`interface ${symbolName}`)) {
          score = 90;
        }

        if (score > highestScore) {
          highestScore = score;
          bestMatch = {
            filePath: fullPath,
            line: lineIdx,
            character: match.index,
          };
          if (score >= 100) return bestMatch;
        }
      }
    }
  }

  return bestMatch;
}

async function handleCalls(
  adapter: ILspAdapter,
  loc: SymbolLocation,
  direction: 'outgoing' | 'incoming',
  depth = 3,
  format: 'tree' | 'json' | 'mermaid' = 'tree'
) {
  const items = await adapter.prepareCallHierarchy(loc.filePath, loc.line, loc.character);
  if (!items || items.length === 0) {
    console.log(`No CallHierarchy target found at ${path.basename(loc.filePath)}:${loc.line + 1}`);
    return;
  }

  const root = items[0];
  const rootLabel = `${root.containerName ? root.containerName + '.' : ''}${root.name}`;

  if (format === 'json') {
    const calls = direction === 'outgoing' ? await adapter.getOutgoingCalls(root) : await adapter.getIncomingCalls(root);
    console.log(JSON.stringify({ root, direction, calls }, null, 2));
    return;
  }

  console.log(`\n📞 LSP Call Hierarchy (${direction.toUpperCase()}): \x1b[36m${rootLabel}\x1b[0m`);
  console.log(`   Location: \x1b[90m${path.basename(loc.filePath)}:${loc.line + 1}\x1b[0m\n`);

  const visited = new Set<string>();

  async function printTree(item: any, currentDepth: number, prefix: string) {
    if (currentDepth >= depth) return;
    const key = `${item.uri}:${item.name}`;
    if (visited.has(key)) return;
    visited.add(key);

    if (direction === 'outgoing') {
      const outgoing = await adapter.getOutgoingCalls(item);
      for (let i = 0; i < outgoing.length; i++) {
        const isLast = i === outgoing.length - 1;
        const branch = isLast ? '└── ' : '├── ';
        const to = outgoing[i].to;
        const toFile = to.uri.split('/').pop();
        console.log(`${prefix}${branch}\x1b[32m↳ calls:\x1b[0m \x1b[33m${to.name}\x1b[0m \x1b[90m(${toFile})\x1b[0m`);
        await printTree(to, currentDepth + 1, prefix + (isLast ? '    ' : '│   '));
      }
    } else {
      const incoming = await adapter.getIncomingCalls(item);
      for (let i = 0; i < incoming.length; i++) {
        const isLast = i === incoming.length - 1;
        const branch = isLast ? '└── ' : '├── ';
        const from = incoming[i].from;
        const fromFile = from.uri.split('/').pop();
        console.log(`${prefix}${branch}\x1b[35m⮤ called by:\x1b[0m \x1b[33m${from.name}\x1b[0m \x1b[90m(${fromFile})\x1b[0m`);
        await printTree(from, currentDepth + 1, prefix + (isLast ? '    ' : '│   '));
      }
    }
  }

  await printTree(root, 0, '');
}

async function handleImpl(adapter: ILspAdapter, loc: SymbolLocation, format: 'tree' | 'json' = 'tree') {
  const impls = await adapter.findImplementations(loc.filePath, loc.line, loc.character);

  if (format === 'json') {
    console.log(JSON.stringify({ location: loc, implementations: impls }, null, 2));
    return;
  }

  console.log(`\n🔍 LSP Implementations for: \x1b[36m${path.basename(loc.filePath)}\x1b[0m (line ${loc.line + 1})`);
  if (impls.length === 0) {
    console.log('   No implementations found.');
    return;
  }

  console.log(`✓ Found ${impls.length} concrete implementation(s):`);
  for (const impl of impls) {
    const implFile = impl.uri.split('/').pop();
    console.log(`   \x1b[32m↳ implements:\x1b[0m \x1b[33m${implFile}\x1b[0m \x1b[90m(line ${impl.range.start.line + 1})\x1b[0m`);
  }
}

async function handleHover(adapter: ILspAdapter, loc: SymbolLocation) {
  const hover = await adapter.getHover(loc.filePath, loc.line, loc.character);
  console.log(`\n💡 LSP Type Hover: \x1b[36m${path.basename(loc.filePath)}\x1b[0m (line ${loc.line + 1})\n`);
  if (!hover) {
    console.log('   No hover information available.');
    return;
  }

  if (typeof hover.contents === 'string') {
    console.log(hover.contents);
  } else if (Array.isArray(hover.contents)) {
    for (const c of hover.contents) {
      console.log(typeof c === 'string' ? c : c.value);
    }
  } else if (typeof hover.contents === 'object' && 'value' in hover.contents) {
    console.log(hover.contents.value);
  }
}

async function handleContext(adapter: ILspAdapter, loc: SymbolLocation, symbolName: string) {
  console.log(`\n================================================================`);
  console.log(`⚡ 360-Degree Compiler Context for: \x1b[36m${symbolName}\x1b[0m`);
  console.log(`   Defined in: ${loc.filePath}:${loc.line + 1}`);
  console.log(`================================================================`);

  // 1. Hover Type
  console.log(`\n[1. Type Signature]`);
  const hover = await adapter.getHover(loc.filePath, loc.line, loc.character);
  if (hover && typeof hover.contents === 'object' && 'value' in hover.contents) {
    console.log(`   ${hover.contents.value.split('\n')[0]}`);
  } else {
    console.log(`   Type resolved at compile-time.`);
  }

  // 2. Implementations
  console.log(`\n[2. Interface Implementations]`);
  const impls = await adapter.findImplementations(loc.filePath, loc.line, loc.character);
  if (impls.length > 0) {
    for (const impl of impls) {
      console.log(`   ↳ ${impl.uri.split('/').pop()}:${impl.range.start.line + 1}`);
    }
  } else {
    console.log(`   (No interface implementations)`);
  }

  // 3. Outgoing Call Hierarchy
  console.log(`\n[3. Outgoing Call Tree]`);
  await handleCalls(adapter, loc, 'outgoing', 2, 'tree');

  // 4. Incoming Callers
  console.log(`\n[4. Incoming Callers]`);
  await handleCalls(adapter, loc, 'incoming', 2, 'tree');
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    console.log(`
Standardized LSP Query CLI:

Usage:
  npx tsx src/lsp/query.ts <command> <project-path> [options]

Commands:
  calls    Retrieve outgoing or incoming call hierarchy tree
  impl     Find concrete class/bean implementations of an interface
  hover    Inspect compiler-resolved type signatures & documentation
  context  Get 360-degree unified compiler context (types, calls, impls)

Options:
  --symbol <name>          Symbol name to query (e.g. 'sayHello', 'HelloWorkflow')
  --file <path>            Target file path (optional if --symbol is given)
  --line <number>          0-indexed line number (optional if --symbol is given)
  --direction <out|in>     Call hierarchy direction ('outgoing' or 'incoming', default: outgoing)
  --depth <number>         Call tree recursion depth (default: 3)
  --json                   Output result in JSON format

Examples:
  npx tsx src/lsp/query.ts calls sample_projects/samples-java/springboot --symbol helloSample
  npx tsx src/lsp/query.ts impl sample_projects/samples-java/springboot --symbol HelloWorkflow
  npx tsx src/lsp/query.ts context sample_projects/spring-boot-demo --symbol showExecutionHistory
`);
    return;
  }

  const command = args[0];
  const projectPath = path.resolve(process.cwd(), args[1] || '.');

  let symbolName = '';
  let filePath = '';
  let line = -1;
  let char = 15;
  let direction: 'outgoing' | 'incoming' = 'outgoing';
  let depth = 3;
  let format: 'tree' | 'json' = args.includes('--json') ? 'json' : 'tree';

  for (let i = 2; i < args.length; i++) {
    if (args[i] === '--symbol' && args[i + 1]) symbolName = args[++i];
    else if (args[i] === '--file' && args[i + 1]) filePath = args[++i];
    else if (args[i] === '--line' && args[i + 1]) line = parseInt(args[++i], 10);
    else if (args[i] === '--direction' && args[i + 1]) direction = args[++i] as any;
    else if (args[i] === '--depth' && args[i + 1]) depth = parseInt(args[++i], 10);
  }

  let loc: SymbolLocation | null = null;

  if (symbolName) {
    loc = findSymbolInWorkspace(projectPath, symbolName);
    if (!loc) {
      console.error(`❌ Symbol '${symbolName}' not found in workspace.`);
      process.exit(1);
    }
  } else if (filePath && line >= 0) {
    loc = {
      filePath: path.resolve(projectPath, filePath),
      line,
      character: char,
    };
  } else {
    console.error(`❌ Error: Specify either --symbol <name> or --file <path> --line <number>.`);
    process.exit(1);
  }

  const registry = new LspAdapterRegistry();
  const adapter = await registry.getOrStartAdapter('java', projectPath);

  if (!adapter) {
    console.error('❌ Failed to start Language Server adapter.');
    process.exit(1);
  }

  try {
    switch (command) {
      case 'calls':
        await handleCalls(adapter, loc, direction, depth, format);
        break;
      case 'impl':
        await handleImpl(adapter, loc, format);
        break;
      case 'hover':
        await handleHover(adapter, loc);
        break;
      case 'context':
        await handleContext(adapter, loc, symbolName || path.basename(loc.filePath));
        break;
      default:
        console.error(`Unknown command: '${command}'. Use --help for available commands.`);
    }
  } finally {
    await registry.shutdownAll();
  }
}

main().catch((err) => {
  console.error('Query execution error:', err);
  process.exit(1);
});
