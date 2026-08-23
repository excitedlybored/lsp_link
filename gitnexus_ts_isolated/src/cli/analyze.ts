/**
 * GitNexus Isolated CLI: Analyze Command with LSP Integration.
 *
 * Full parity with original `gitnexus analyze` command line interface,
 * with added `--lsp` support for live Language Server precision enrichment.
 */

import { Command } from 'commander';
import * as path from 'path';
import * as fs from 'fs';
import { resolvePipelineStage, type PipelineStage } from '../ingestion/pipeline-stage.js';
import { runPipelineStage } from '../ingestion/sub-pipelines/index.js';
import { persistAnalyzeArtifacts } from './persist-analyze.js';
import { PipelineProgress } from '../shared/pipeline.js';

export function createAnalyzeCommand(): Command {
  const cmd = new Command('analyze');

  cmd
    .description('Index a repository (full analysis) with optional LSP enrichment')
    .argument('[path]', 'Path to target repository (default: current directory)', '.')
    .option('-f, --force', 'Force full re-index even if up to date')
    .option('--skip-git', 'Allow indexing folders without a .git directory', true)
    .option('--skip-graph-phases', 'Skip MRO, community detection, and process extraction')
    .option('--workers <number>', 'Worker pool size override', parseInt)
    .option('--lsp', '⚡ Enable Language Server Protocol (JDT.LS / LSP) precision enrichment (default: true)', true)
    .option('--no-lsp', 'Disable Language Server Protocol precision enrichment (AST only)')
    .option('--lsp-language <lang>', 'Target language for LSP adapter (default: java)', 'java')
    .option('--lsp-depth <depth>', 'Maximum LSP call hierarchy recursion depth', parseInt, 3)
    .option(
      '--pipeline <stage>',
      'Sub-pipeline: full (default, treesitter + lsp + analysis), treesitter, or lsp',
      'full',
    )
    .action(async (targetPath: string, options: any) => {
      const resolvedRepoPath = path.resolve(process.cwd(), targetPath);

      const pipelineStage: PipelineStage = resolvePipelineStage(options.pipeline);
      const isLspEnabled = pipelineStage === 'lsp' ? true : pipelineStage === 'treesitter' ? false : options.lsp !== false;

      console.log(`\n  GitNexus Analyzer (Isolated Engine)`);
      const stageLabel =
        pipelineStage === 'treesitter'
          ? 'treesitter (parse only)'
          : pipelineStage === 'lsp'
            ? 'lsp (enrich saved graph)'
            : 'full (treesitter + lsp + analysis)';
      console.log(`  Pipeline: ${stageLabel}`);
      if (pipelineStage === 'treesitter') {
        console.log(`  ⚡ LSP Precision Mode: skipped (treesitter pipeline)`);
      } else if (isLspEnabled) {
        console.log(`  ⚡ LSP Precision Mode: ENABLED (Default) [Language: ${options.lspLanguage}]`);
      } else {
        console.log(`  ⚡ LSP Precision Mode: DISABLED (--no-lsp AST only)`);
      }
      console.log(`  Target: ${resolvedRepoPath}\n`);

      if (!fs.existsSync(resolvedRepoPath)) {
        console.error(`❌ Error: Target project path '${resolvedRepoPath}' does not exist.`);
        process.exit(1);
      }

      const startTime = Date.now();

      const onProgress = (p: PipelineProgress) => {
        const percentStr = String(p.percent).padStart(3, ' ');
        console.log(`  [${percentStr}%] [${p.phase.padEnd(16)}] ${p.message}`);
      };

      try {
        const result = await runPipelineStage(resolvedRepoPath, onProgress, {
          stage: pipelineStage,
          lsp: isLspEnabled,
          skipGraphPhases: options.skipGraphPhases === true,
          pdg: options.pdg === true,
          workerPoolSize: options.workers,
        });

        const duration = ((Date.now() - startTime) / 1000).toFixed(1);

        console.log(`\n  Repository indexed successfully (${duration}s)\n`);
        console.log(
          `  ${result.graph.nodeCount} nodes | ${result.graph.relationshipCount} edges | ` +
          `${result.communityResult?.stats.totalCommunities ?? 0} clusters | ` +
          `${result.processResult?.stats.totalProcesses ?? 0} flows`
        );
        console.log(`  ${resolvedRepoPath}\n`);

        await persistAnalyzeArtifacts(resolvedRepoPath, result, {
          pipelineStage,
          lspEnriched: isLspEnabled,
        });
      } catch (err: any) {
        console.error(`\n  Analysis failed:`, err.message || err);
        process.exit(1);
      }
    });

  return cmd;
}

if (process.argv[1] && process.argv[1].endsWith('analyze.ts')) {
  const program = new Command();
  program.name('gitnexus').description('GitNexus Isolated CLI');
  program.addCommand(createAnalyzeCommand());

  // Default to the analyze command unless the user named one explicitly.
  const rawArgs = process.argv.slice(2);
  if (rawArgs[0] !== 'analyze' && rawArgs[0] !== 'help') {
    process.argv.splice(2, 0, 'analyze');
  }

  program.parse(process.argv);
}
