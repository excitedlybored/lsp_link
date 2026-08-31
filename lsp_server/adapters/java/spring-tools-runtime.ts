import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface SpringToolsRuntime {
  extensionDir: string;
  languageServerJar: string;
  jdtBundles: string[];
}

function extensionCandidates(): string[] {
  const configured = process.env.GITNEXUS_SPRING_TOOLS_HOME;
  const home = os.homedir();
  const candidates = [
    configured,
    ...cloneLocalExtensionCandidates(),
    path.join(home, '.cache', 'gitnexus', 'spring-tools', 'current', 'extension'),
    path.join(home, 'Library', 'Application Support', 'Code', 'User', 'globalStorage', 'vmware.vscode-spring-boot', 'extension'),
  ].filter((value): value is string => Boolean(value));
  for (const extensionsDir of [path.join(home, '.vscode', 'extensions'), path.join(home, '.cursor', 'extensions')]) {
    if (!fs.existsSync(extensionsDir)) continue;
    for (const name of fs.readdirSync(extensionsDir)) {
      if (name.startsWith('vmware.vscode-spring-boot-')) candidates.push(path.join(extensionsDir, name));
    }
  }
  return candidates;
}

function cloneLocalExtensionCandidates(): string[] {
  const candidates: string[] = [];
  let current = path.resolve(process.cwd());
  while (true) {
    candidates.push(path.join(current, '.gitnexus', 'tools', 'spring-tools', '5.3.0.RELEASE', 'extension'));
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return candidates;
}

export function locateSpringToolsRuntime(): SpringToolsRuntime | null {
  for (const candidate of extensionCandidates()) {
    const extensionDir = path.resolve(candidate);
    const serverDir = path.join(extensionDir, 'language-server');
    if (!fs.existsSync(serverDir)) continue;
    const languageServerJar = fs.readdirSync(serverDir)
      .filter((name) => name.includes('spring-boot-language-server') && name.endsWith('.jar'))
      .map((name) => path.join(serverDir, name))[0];
    if (!languageServerJar) continue;
    const bundleDir = path.join(extensionDir, 'jars');
    const jdtBundles = fs.existsSync(bundleDir)
      ? fs.readdirSync(bundleDir).filter((name) => name.endsWith('.jar')).map((name) => path.join(bundleDir, name))
      : [];
    return { extensionDir, languageServerJar, jdtBundles };
  }
  return null;
}

export function springToolsEnabled(): boolean {
  return !['0', 'false', 'off', 'no'].includes((process.env.GITNEXUS_SPRING_TOOLS ?? 'true').toLowerCase());
}
