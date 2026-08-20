/**
 * Standalone LSP Adapter Runner with CLI parameters and auto-discovery.
 */

import * as path from 'path';
import * as fs from 'fs';
import { globSync } from 'glob';
import { LspAdapterRegistry } from './registry/lsp-adapter-registry.js';

async function main() {
  const args = process.argv.slice(2);
  const targetProject = args[0] || 'sample_projects/samples-java/springboot';
  const resolvedPath = path.resolve(process.cwd(), targetProject);

  console.log(`================================================================`);
  console.log(`⚡ Testing GitNexus LSP Adapter (Language: Java / JDT.LS)`);
  console.log(`   Target Project: ${resolvedPath}`);
  console.log(`================================================================`);

  const registry = new LspAdapterRegistry();
  const javaAdapter = await registry.getOrStartAdapter('java', resolvedPath);

  if (!javaAdapter) {
    console.error('❌ Failed to start Java JDT.LS Adapter.');
    process.exit(1);
  }

  console.log('✓ Java JDT.LS Adapter started & initialized successfully.');

  // Find Java files in project
  const javaFiles = globSync('src/main/java/**/*.java', { cwd: resolvedPath });
  console.log(`✓ Found ${javaFiles.length} Java source files.`);

  // 1. Test Workflow Interfaces for Implementations
  for (const relFile of javaFiles) {
    const fullPath = path.join(resolvedPath, relFile);
    const content = fs.readFileSync(fullPath, 'utf-8');

    if (content.includes('@WorkflowInterface') || content.includes('interface ')) {
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes('interface ')) {
          const charIndex = lines[i].indexOf('interface ') + 10;
          console.log(`\n[LSP Implementation Query] ${relFile} (line ${i + 1})...`);
          const impls = await javaAdapter.findImplementations(fullPath, i, charIndex);
          if (impls.length > 0) {
            console.log(`✓ Concrete Implementations Found (${impls.length}):`);
            for (const impl of impls) {
              const implName = impl.uri.split('/').pop();
              console.log(`   ↳ implements: ${implName}`);
            }
          }
        }
      }
    }
  }

  // 2. Test Workflow / Controller Methods for Call Hierarchy
  for (const relFile of javaFiles) {
    const fullPath = path.join(resolvedPath, relFile);
    const content = fs.readFileSync(fullPath, 'utf-8');

    if (content.includes('@WorkflowMethod') || content.includes('@GetMapping') || content.includes('@PostMapping')) {
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (
          lines[i].includes('public ') &&
          (lines[i].includes('String ') || lines[i].includes('CloudEvent ') || lines[i].includes('ResponseEntity'))
        ) {
          const match = lines[i].match(/public\s+[\w<>]+\s+(\w+)\s*\(/);
          if (match) {
            const methodName = match[1];
            const charIndex = lines[i].indexOf(methodName);
            console.log(`\n[LSP Call Hierarchy Query] ${relFile}#${methodName} (line ${i + 1})...`);
            const items = await javaAdapter.prepareCallHierarchy(fullPath, i, charIndex);

            if (items && items.length > 0) {
              const root = items[0];
              console.log(`✓ Call Item Resolved: ${root.name} (${root.detail || ''})`);

              const outgoing = await javaAdapter.getOutgoingCalls(root);
              if (outgoing.length > 0) {
                console.log(`   📞 Outgoing Calls (${outgoing.length}):`);
                for (const call of outgoing) {
                  const calleeName = call.to.name;
                  const calleeFile = call.to.uri.split('/').pop();
                  console.log(`      ↳ calls: ${calleeName} (${calleeFile})`);
                }
              }

              const incoming = await javaAdapter.getIncomingCalls(root);
              if (incoming.length > 0) {
                console.log(`   📞 Incoming Calls (${incoming.length}):`);
                for (const call of incoming) {
                  const callerName = call.from.name;
                  const callerFile = call.from.uri.split('/').pop();
                  console.log(`      ⮤ called by: ${callerName} (${callerFile})`);
                }
              }
            }
          }
        }
      }
    }
  }

  await registry.shutdownAll();
  console.log('\n✓ LSP Adapter tests completed & shutdown cleanly.');
}

main().catch((err) => {
  console.error('Error running LSP adapter:', err);
  process.exit(1);
});
