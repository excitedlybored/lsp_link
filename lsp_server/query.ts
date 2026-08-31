/**
 * Standardized Polyglot LSP Query Engine & CLI.
 *
 * Provides a unified query interface for LSP operations across all banking languages
 * (Java, Python, C++, Rust, TypeScript, C#, COBOL):
 *   - calls    : Outgoing / incoming call hierarchy
 *   - impl     : Interface to concrete implementation lookup
 *   - hover    : Type definitions & doc hover
 *   - context  : 360-degree compiler symbol context
 *
 * Automatically resolves symbol names across polyglot source trees to exact coordinates.
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
  language: string;
  containerName?: string;
  kind?: string;
}

/**
 * Scans polyglot source files to resolve a symbol name to its file location and language.
 */
function findSymbolInWorkspace(
  workspacePath: string,
  symbolName: string,
  registry: LspAdapterRegistry,
  langOverride?: string,
): SymbolLocation | null {
  const sourceFiles = globSync(
    registry.getSupportedFileExtensions().map((extension) => `**/*${extension}`), {
    cwd: workspacePath,
    ignore: ['node_modules/**', 'dist/**', 'target/**', '.git/**', '.venv/**', 'build/**'],
    },
  );
  const escapedSymbolName = escapeRegExp(symbolName);

  let bestMatch: SymbolLocation | null = null;
  let highestScore = 0;

  for (const relFile of sourceFiles) {
    const fullPath = path.join(workspacePath, relFile);
    const ext = path.extname(fullPath).toLowerCase();
    const lines = fs.readFileSync(fullPath, 'utf-8').split('\n');

    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      const line = lines[lineIdx];
      const trimmed = line.trim();

      if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('#') || trimmed.startsWith('import ')) {
        continue;
      }

      const regex = new RegExp(`\\b${escapedSymbolName}\\b`);
      const match = regex.exec(line);

      if (match) {
        let score = 1;
        // Generic & language-specific definition patterns
        if (new RegExp(`(public|protected|private)?\\s*(interface|class|enum|record|struct|trait|impl)\\s+${escapedSymbolName}\\b`).test(trimmed)) {
          score = 100;
        } else if (new RegExp(`(def|fn|function)\\s+${escapedSymbolName}\\b`).test(trimmed)) {
          score = 95;
        } else if (new RegExp(`PROGRAM-ID\\.\\s+${escapedSymbolName}\\b`, 'i').test(trimmed) || trimmed.startsWith(`${symbolName} SECTION.`)) {
          score = 95;
        } else if (new RegExp(`(public|protected|private)?\\s+[\\w<>\\[\\]]+\\s+${escapedSymbolName}\\s*\\(`).test(trimmed)) {
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
            language: langOverride || registry.getLanguageForFile(fullPath) || path.extname(fullPath).slice(1),
          };
          if (score >= 100) return bestMatch;
        }
      }
    }
  }

  return bestMatch;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
  console.log(`   File: ${loc.filePath}:${loc.line + 1}\n`);

  const visited = new Set<string>();

  async function printTree(item: any, currentDepth: number, prefix: string) {
    if (currentDepth > depth) return;
    const key = `${item.uri}:${item.range.start.line}:${item.name}`;
    if (visited.has(key)) {
      console.log(`${prefix}└── \x1b[90m${item.name} (recursive)\x1b[0m`);
      return;
    }
    visited.add(key);

    const targets = direction === 'outgoing'
      ? (await adapter.getOutgoingCalls(item)).map((call) => call.to)
      : (await adapter.getIncomingCalls(item)).map((call) => call.from);

    for (let i = 0; i < targets.length; i++) {
      const target = targets[i]!;
      const isLast = i === targets.length - 1;
      const branch = isLast ? '└── ' : '├── ';
      const nextPrefix = prefix + (isLast ? '    ' : '│   ');

      const targetLabel = target.containerName ? `\x1b[33m${target.containerName}\x1b[0m.${target.name}` : `\x1b[32m${target.name}\x1b[0m`;
      console.log(`${prefix}${branch}${targetLabel}`);

      await printTree(target, currentDepth + 1, nextPrefix);
    }
  }

  await printTree(root, 1, '  ');
  console.log('');
}

async function handleImpl(
  adapter: ILspAdapter,
  loc: SymbolLocation,
  symbolName: string
) {
  const impls = await adapter.findImplementations(loc.filePath, loc.line, loc.character);

  console.log(`\n🔗 LSP Concrete Implementations for: \x1b[36m${symbolName}\x1b[0m`);
  console.log(`   Declared at: ${path.basename(loc.filePath)}:${loc.line + 1}\n`);

  if (!impls || impls.length === 0) {
    console.log(`   (No concrete implementations found or symbol is already concrete)`);
    return;
  }

  for (const impl of impls) {
    const file = impl.uri.replace('file://', '');
    const line = (impl.range?.start?.line ?? 0) + 1;
    console.log(`   • \x1b[32m${path.basename(file)}:${line}\x1b[0m \x1b[90m(${file})\x1b[0m`);
  }
  console.log('');
}

async function handleHover(
  adapter: ILspAdapter,
  loc: SymbolLocation,
  symbolName: string
) {
  const hover = await adapter.getHover(loc.filePath, loc.line, loc.character);

  console.log(`\n🔍 LSP Type & Documentation Hover: \x1b[36m${symbolName}\x1b[0m`);
  console.log(`   Location: ${path.basename(loc.filePath)}:${loc.line + 1}\n`);

  if (!hover || !hover.contents) {
    console.log(`   (No hover information available)`);
    return;
  }

  console.log(hover.contents);
  console.log('');
}

async function handleContext(
  adapter: ILspAdapter,
  loc: SymbolLocation,
  symbolName: string
) {
  console.log(`\n========================================================================`);
  console.log(`⚡ 360-DEGREE LSP COMPILER CONTEXT: \x1b[36m${symbolName}\x1b[0m`);
  console.log(`   File: ${loc.filePath}:${loc.line + 1}`);
  console.log(`========================================================================`);

  await handleHover(adapter, loc, symbolName);
  await handleImpl(adapter, loc, symbolName);
  await handleCalls(adapter, loc, 'outgoing', 2);
  await handleCalls(adapter, loc, 'incoming', 2);
}

// ============================================================================
// CLI PARSER & MAIN
// ============================================================================

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === '--help' || command === '-h') {
    console.log(`
Standardized Polyglot LSP Query CLI

Commands:
  calls <project> --symbol <name> [--direction outgoing|incoming] [--depth <n>]
  impl <project> --symbol <name>
  hover <project> --symbol <name>
  context <project> --symbol <name>

Supported Languages:
  Java, Python, C++, Rust, TypeScript, C#, COBOL

Options:
  --file <relPath>      Specify target file explicitly
  --line <n>            Specify 1-indexed line number
  --char <n>            Specify 0-indexed character offset
  --direction <dir>     Call hierarchy direction: 'outgoing' (default) or 'incoming'
  --depth <n>           Call tree recursion depth (default: 3)
  --format <fmt>        Output format: 'tree' (default), 'json', 'mermaid'
  --language <lang>     Language server override (e.g. 'python', 'cpp', 'rust', 'java')
`);
    return;
  }

  const workspaceArg = args[1] || '.';
  const workspacePath = path.resolve(process.cwd(), workspaceArg);

  let symbolName = '';
  let filePath = '';
  let line = 0;
  let character = 0;
  let direction: 'outgoing' | 'incoming' = 'outgoing';
  let depth = 3;
  let format: 'tree' | 'json' | 'mermaid' = 'tree';
  let languageOverride = '';

  for (let i = 2; i < args.length; i++) {
    if (args[i] === '--symbol' && args[i + 1]) symbolName = args[++i];
    if (args[i] === '--file' && args[i + 1]) filePath = args[++i];
    if (args[i] === '--line' && args[i + 1]) line = parseInt(args[++i], 10) - 1;
    if (args[i] === '--char' && args[i + 1]) character = parseInt(args[++i], 10);
    if (args[i] === '--direction' && args[i + 1]) direction = args[++i] as any;
    if (args[i] === '--depth' && args[i + 1]) depth = parseInt(args[++i], 10);
    if (args[i] === '--format' && args[i + 1]) format = args[++i] as any;
    if (args[i] === '--language' && args[i + 1]) languageOverride = args[++i];
  }

  const registry = new LspAdapterRegistry();
  let loc: SymbolLocation | null = null;

  if (filePath) {
    loc = {
      filePath: path.resolve(workspacePath, filePath),
      line,
      character,
      language: languageOverride || path.extname(filePath).slice(1),
    };
  } else if (symbolName) {
    loc = findSymbolInWorkspace(workspacePath, symbolName, registry, languageOverride);
  }

  if (!loc) {
    console.error(`❌ Could not resolve coordinates for symbol '${symbolName}'. Specify --file and --line.`);
    process.exit(1);
  }

  const langKey = registry.getLanguageForFile(loc.filePath) || loc.language || 'java';

  const adapter = languageOverride
    ? await registry.getOrStartAdapter(languageOverride, workspacePath)
    : await registry.getOrStartAdapterForFile(loc.filePath, workspacePath);
  if (!adapter) {
    console.error(`❌ No active or available LSP adapter found for language '${langKey}'.`);
    process.exit(1);
  }

  try {
    switch (command) {
      case 'calls':
        await handleCalls(adapter, loc, direction, depth, format);
        break;
      case 'impl':
        await handleImpl(adapter, loc, symbolName);
        break;
      case 'hover':
        await handleHover(adapter, loc, symbolName);
        break;
      case 'context':
        await handleContext(adapter, loc, symbolName);
        break;
      default:
        console.error(`Unknown command '${command}'. Use --help.`);
        process.exit(1);
    }
  } finally {
    await registry.shutdownAll();
  }
}

main().catch((err) => {
  console.error('Fatal LSP Query error:', err);
  process.exit(1);
});
