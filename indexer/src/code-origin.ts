import path from 'node:path';

/** Stable ownership vocabulary persisted across source, build, and JVM evidence. */
export const CODE_ORIGINS = [
  'repository',
  'generated_first_party',
  'first_party_artifact',
  'third_party_dependency',
  'standard_library',
  'unknown',
] as const;

export type CodeOrigin = (typeof CODE_ORIGINS)[number];

export function codeOriginForDocumentOrigin(
  origin: 'workspace' | 'generated' | 'dependency' | 'standard_library' | 'unknown',
): CodeOrigin {
  switch (origin) {
    case 'workspace': return 'repository';
    case 'generated': return 'generated_first_party';
    case 'dependency': return 'third_party_dependency';
    case 'standard_library': return 'standard_library';
    case 'unknown': return 'unknown';
  }
}

export function isExternalCodeOrigin(origin: CodeOrigin): boolean {
  return origin === 'third_party_dependency' || origin === 'standard_library' || origin === 'unknown';
}

export interface ArtifactCodeOriginInput {
  artifactPath: string;
  workspacePath?: string;
  providerIds?: string[];
  coordinate?: string;
}

/** Classifies an artifact before it is copied into the content-addressed cache. */
export function classifyArtifactCodeOrigin(input: ArtifactCodeOriginInput): CodeOrigin {
  const artifactPath = path.resolve(input.artifactPath);
  if (looksLikeStandardLibraryArtifact(artifactPath)) return 'standard_library';
  if (input.workspacePath && isInsideOrEqual(input.workspacePath, artifactPath)) {
    return 'first_party_artifact';
  }
  const normalized = artifactPath.replaceAll('\\', '/').toLowerCase();
  if (input.coordinate
    || /\/(?:\.m2\/repository|\.gradle\/caches|external|third_party)\//.test(normalized)) {
    return 'third_party_dependency';
  }
  if (input.providerIds?.includes('bazel-java-info')
    && normalized.includes('/bazel-out/')) {
    return 'first_party_artifact';
  }
  return 'unknown';
}

function looksLikeStandardLibraryArtifact(artifactPath: string): boolean {
  const normalized = artifactPath.replaceAll('\\', '/').toLowerCase();
  const basename = path.basename(normalized);
  if (basename === 'rt.jar' || basename === 'jce.jar' || basename === 'jsse.jar') return true;
  if (normalized.includes('/jmods/') || normalized.includes('/lib/jrt-fs.jar')) return true;
  for (const javaHome of [process.env.JAVA_HOME, process.env.JDK_HOME].filter(Boolean) as string[]) {
    if (isInsideOrEqual(javaHome, artifactPath)) return true;
  }
  return false;
}

function isInsideOrEqual(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
