import fs from 'node:fs';
import path from 'node:path';
import { isJarPath } from './descriptor-normalizer.js';
import type { ArtifactClasspathResolutionContext, ResolvedClasspathEntry } from './types.js';

interface JdtClasspathCommandResult {
  classpaths?: unknown;
  modulepaths?: unknown;
}

export async function loadJdtRuntimeClasspath(
  context: ArtifactClasspathResolutionContext,
): Promise<ResolvedClasspathEntry[]> {
  if (!context.lspClient) return [];
  const projectUris = await loadJdtProjectUris(context);
  const queryUris = projectUris.length > 0 ? projectUris : context.documentUris.slice(0, 1);
  const entriesByPath = new Map<string, ResolvedClasspathEntry>();
  for (const uri of queryUris) {
    const response = await context.lspClient.request<JdtClasspathCommandResult>('workspace/executeCommand', {
      command: 'java.project.getClasspaths',
      // JDT LS JSONUtility requires extension-specific option models as JSON strings.
      arguments: [uri, JSON.stringify({ scope: 'runtime' })],
    });
    addExistingJarPaths(entriesByPath, response.classpaths, false);
    addExistingJarPaths(entriesByPath, response.modulepaths, true);
  }
  return [...entriesByPath.values()];
}

async function loadJdtProjectUris(context: ArtifactClasspathResolutionContext): Promise<string[]> {
  if (!context.lspClient) return [];
  try {
    const projects = await context.lspClient.request<unknown>('workspace/executeCommand', {
      command: 'java.project.getAll',
      arguments: [JSON.stringify({ includeNonJava: false })],
    });
    return Array.isArray(projects)
      ? projects.filter((value): value is string => typeof value === 'string')
      : [];
  } catch {
    return [];
  }
}

function addExistingJarPaths(
  entriesByPath: Map<string, ResolvedClasspathEntry>,
  values: unknown,
  modulePath: boolean,
): void {
  if (!Array.isArray(values)) return;
  for (const value of values) {
    if (typeof value !== 'string' || !isJarPath(value) || !fs.existsSync(value)) continue;
    const absolutePath = path.resolve(value);
    const existing = entriesByPath.get(absolutePath);
    entriesByPath.set(absolutePath, {
      path: absolutePath,
      modulePath: existing?.modulePath === true || modulePath,
    });
  }
}
