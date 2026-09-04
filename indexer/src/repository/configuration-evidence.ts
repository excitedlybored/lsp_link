import fs from 'node:fs/promises';
import path from 'node:path';
import {
  repositoryStableId,
  type ConfigurationReference,
  type ConfigurationValue,
  type RepositoryInventoryBatch,
} from './model.js';

export interface ConfigurationEvidenceOptions {
  sources: Array<'spring' | 'kubernetes' | 'helm'>;
  activeProfiles?: string[];
  helmValuesFiles?: string[];
}

/** Lexically records candidates and provenance; it deliberately does not pick a runtime value. */
export async function addConfigurationEvidence(
  batch: RepositoryInventoryBatch,
  options: ConfigurationEvidenceOptions,
): Promise<void> {
  const enabled = new Set(options.sources);
  if (enabled.size === 0) return;
  const keys = new Map(batch.configurationKeys.map((value) => [value.name, value]));
  const addKey = (name: string) => {
    const normalized = name.trim();
    const current = keys.get(normalized);
    if (current) return current;
    const created = { id: repositoryStableId('configuration-key', normalized), name: normalized };
    keys.set(normalized, created);
    return created;
  };

  for (const document of batch.documents.filter((value) => value.kind === 'configuration')) {
    const sourceKind = classify(document.relativePath, enabled, options.helmValuesFiles ?? []);
    if (!sourceKind) continue;
    const content = await fs.readFile(document.path, 'utf8');
    const profile = springProfile(document.relativePath);
    const values = document.languageId === 'properties'
      ? propertyValues(document.id, content, sourceKind, profile, addKey)
      : yamlValues(document.id, content, sourceKind, profile, addKey);
    if (sourceKind === 'kubernetes') {
      values.push(...kubernetesEnvironmentValues(document.id, content, addKey));
    }
    batch.configurationValues.push(...values);
    for (const value of values) {
      batch.configurationReferences.push(...references(value, addKey));
    }
    if (sourceKind === 'kubernetes') {
      batch.deploymentUnits.push(...deploymentUnits(document.id, content));
    }
  }
  batch.configurationKeys = [...keys.values()].sort((left, right) => left.name.localeCompare(right.name));
}

function propertyValues(
  documentId: string,
  content: string,
  sourceKind: ConfigurationValue['sourceKind'],
  profile: string | undefined,
  addKey: (name: string) => { id: string; name: string },
): ConfigurationValue[] {
  return content.split(/\r?\n/).flatMap((line, startLine) => {
    const match = line.match(/^\s*([^#!\s][^=:\s]*)\s*[:=]\s*(.*)$/);
    if (!match) return [];
    return [configurationValue(
      documentId, match[1]!, stripQuotes(match[2]!), sourceKind,
      profile ? `spring-profile:${profile}` : 'spring-default', profile,
      profile ? 30 : 10, startLine, line.indexOf(match[1]!), addKey,
    )];
  });
}

function yamlValues(
  documentId: string,
  content: string,
  sourceKind: ConfigurationValue['sourceKind'],
  profile: string | undefined,
  addKey: (name: string) => { id: string; name: string },
): ConfigurationValue[] {
  const stack: Array<{ indent: number; key: string }> = [];
  const result: ConfigurationValue[] = [];
  for (const [startLine, line] of content.split(/\r?\n/).entries()) {
    if (/^\s*(?:#|$)/.test(line)) continue;
    const match = line.match(/^(\s*)(?:-\s*)?([A-Za-z_][\w.-]*)\s*:\s*(.*)$/);
    if (!match) continue;
    const indent = match[1]!.length;
    while (stack.length > 0 && stack[stack.length - 1]!.indent >= indent) stack.pop();
    const key = [...stack.map((value) => value.key), match[2]!].join('.');
    const raw = stripQuotes(match[3]!.replace(/\s+#.*$/, '').trim());
    if (!raw || raw === '|' || raw === '>') {
      stack.push({ indent, key: match[2]! });
      continue;
    }
    const scope = sourceKind === 'helm' ? 'helm-values'
      : sourceKind === 'kubernetes' ? 'kubernetes-manifest'
      : profile ? `spring-profile:${profile}` : 'spring-default';
    result.push(configurationValue(
      documentId, key, raw, sourceKind, scope, profile,
      sourceKind === 'helm' ? 40 : sourceKind === 'kubernetes' ? 50 : profile ? 30 : 10,
      startLine, line.indexOf(match[2]!), addKey,
    ));
  }
  return result;
}

function configurationValue(
  documentId: string,
  name: string,
  rawValue: string,
  sourceKind: ConfigurationValue['sourceKind'],
  scope: string,
  profile: string | undefined,
  precedence: number,
  startLine: number,
  startCharacter: number,
  addKey: (name: string) => { id: string; name: string },
): ConfigurationValue {
  const key = addKey(name);
  const symbolic = /\$\{|\.Values\.|(?:secret|configmap):\/\/|(?:secret|configMap)KeyRef/.test(rawValue);
  const defaultValue = rawValue.match(/\$\{[^}:]+:([^}]*)\}/)?.[1];
  return {
    id: repositoryStableId('configuration-value', documentId, name, String(startLine), rawValue),
    documentId, keyId: key.id, key: name, rawValue,
    resolvedValue: defaultValue === undefined ? (symbolic ? undefined : rawValue) : defaultValue,
    status: symbolic ? 'symbolic' : 'exact', sourceKind, scope, profile,
    precedence, confidence: symbolic ? 0.65 : 1, startLine, startCharacter,
  };
}

function references(
  value: ConfigurationValue,
  addKey: (name: string) => { id: string; name: string },
): ConfigurationReference[] {
  const matches: Array<{ name: string; kind: ConfigurationReference['kind'] }> = [];
  for (const match of value.rawValue.matchAll(/\$\{([^}:]+)(?::[^}]*)?\}/g)) {
    matches.push({ name: match[1]!, kind: /^[A-Z][A-Z0-9_]*$/.test(match[1]!) ? 'environment' : 'placeholder' });
  }
  for (const match of value.rawValue.matchAll(/\.Values\.([A-Za-z0-9_.-]+)/g)) {
    matches.push({ name: match[1]!, kind: 'helm-value' });
  }
  for (const match of value.rawValue.matchAll(/configmap:\/\/([^/\s]+)\/([^\s}]+)/g)) {
    matches.push({ name: `${match[1]}.${match[2]}`, kind: 'config-map' });
  }
  for (const match of value.rawValue.matchAll(/secret:\/\/([^/\s]+)\/([^\s}]+)/g)) {
    matches.push({ name: `${match[1]}.${match[2]}`, kind: 'secret' });
  }
  return matches.map(({ name, kind }, ordinal) => {
    const target = addKey(name);
    return {
      id: repositoryStableId('configuration-reference', value.id, target.id, kind, String(ordinal)),
      valueId: value.id, targetKeyId: target.id, targetKey: name, kind, status: 'symbolic',
    };
  });
}

function kubernetesEnvironmentValues(
  documentId: string,
  content: string,
  addKey: (name: string) => { id: string; name: string },
): ConfigurationValue[] {
  const lines = content.split(/\r?\n/);
  const result: ConfigurationValue[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const match = line.match(/^(\s*)-\s*name:\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?\s*$/);
    if (!match) continue;
    const indent = match[1]!.length;
    const block: string[] = [];
    let end = index + 1;
    for (; end < lines.length; end += 1) {
      const candidate = lines[end]!;
      if (candidate.trim() && candidate.match(/^\s*/)?.[0].length! <= indent) break;
      block.push(candidate);
    }
    const directIndent = indent + 2;
    const atDirectIndent = (candidate: string) => candidate.match(/^\s*/)?.[0].length === directIndent;
    const direct = block.find((candidate) => atDirectIndent(candidate) && /^\s+value:\s*/.test(candidate))
      ?.replace(/^\s+value:\s*/, '');
    const hasValueFrom = block.some((candidate) => atDirectIndent(candidate) && /valueFrom\s*:/.test(candidate));
    const referenceKind = hasValueFrom && block.some((candidate) => /configMapKeyRef\s*:/.test(candidate))
      ? 'configmap' : hasValueFrom && block.some((candidate) => /secretKeyRef\s*:/.test(candidate)) ? 'secret' : undefined;
    const referenceName = block.find((candidate) => /^\s+name:\s*/.test(candidate))
      ?.replace(/^\s+name:\s*/, '').replace(/['"]/g, '').trim();
    const referenceKey = block.find((candidate) => /^\s+key:\s*/.test(candidate))
      ?.replace(/^\s+key:\s*/, '').replace(/['"]/g, '').trim();
    const raw = direct === undefined
      ? referenceKind && referenceName && referenceKey
        ? `${referenceKind}://${referenceName}/${referenceKey}`
        : undefined
      : stripQuotes(direct.trim());
    if (raw === undefined) continue;
    result.push(configurationValue(
      documentId, match[2]!, raw, 'kubernetes', 'kubernetes-environment', undefined,
      60, index, line.indexOf(match[2]!), addKey,
    ));
    index = end - 1;
  }
  return result;
}

function deploymentUnits(documentId: string, content: string) {
  return content.split(/^---\s*$/m).flatMap((yaml, ordinal) => {
    const kind = yaml.match(/^kind:\s*['"]?([^'"\s]+)['"]?/m)?.[1];
    const metadata = yaml.match(/^metadata:\s*\n((?:^[ \t]+.*\n?)*)/m)?.[1] ?? '';
    const name = metadata.match(/^\s+name:\s*['"]?([^'"\s]+)['"]?/m)?.[1];
    if (!kind || !name) return [];
    const namespace = metadata.match(/^\s+namespace:\s*['"]?([^'"\s]+)['"]?/m)?.[1];
    return [{
      id: repositoryStableId('deployment-unit', documentId, kind, name, String(ordinal)),
      documentId, kind, name, namespace,
    }];
  });
}

function classify(
  relativePath: string,
  enabled: Set<'spring' | 'kubernetes' | 'helm'>,
  explicitHelmFiles: string[],
): ConfigurationValue['sourceKind'] | undefined {
  const normalized = relativePath.replaceAll('\\', '/');
  if (enabled.has('helm') && (/(?:^|\/)values(?:-[^/]+)?\.ya?ml$/.test(normalized)
    || /(?:^|\/)templates\//.test(normalized)
    || explicitHelmFiles.some((file) => file.endsWith(normalized)))) return 'helm';
  if (enabled.has('kubernetes') && (/(?:^|\/)k8s\//.test(normalized)
    || /(?:^|\/)kubernetes\//.test(normalized))) return 'kubernetes';
  if (enabled.has('spring') && /(?:^|\/)application(?:-[^/]+)?\.(?:properties|ya?ml)$/.test(normalized)) return 'spring';
  return undefined;
}

function springProfile(relativePath: string): string | undefined {
  return path.posix.basename(relativePath).match(/^application-([^.]+)\.(?:properties|ya?ml)$/)?.[1];
}

function stripQuotes(value: string): string {
  return value.replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, (_match, double, single) => double ?? single);
}
