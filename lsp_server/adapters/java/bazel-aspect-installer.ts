import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const BAZEL_ASPECT_RELATIVE_PATH = '.gitnexus/jdtls/bazel-source-aspect.bzl';

const SOURCE_ASPECT_PATH = fileURLToPath(
  new URL('./assets/gitnexus_java_graph.bzl', import.meta.url),
);

/** Installs the versioned, checked-in aspect into the repository Bazel workspace. */
export function ensureBazelSourceAspect(workspacePath: string): void {
  const destination = path.join(workspacePath, BAZEL_ASPECT_RELATIVE_PATH);
  const buildPath = path.join(path.dirname(destination), 'BUILD.bazel');
  const aspect = fs.readFileSync(SOURCE_ASPECT_PATH, 'utf8');
  const build = `exports_files(["${path.basename(destination)}"])\n`;
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  writeIfChanged(destination, aspect);
  writeIfChanged(buildPath, build);
}

function writeIfChanged(destination: string, contents: string): void {
  if (!fs.existsSync(destination) || fs.readFileSync(destination, 'utf8') !== contents) {
    fs.writeFileSync(destination, contents);
  }
}
