import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { addConfigurationEvidence } from '../src/repository/configuration-evidence.js';
import { emptyRepositoryInventoryBatch, repositoryStableId } from '../src/repository/model.js';

test('preserves Spring, Helm, and Kubernetes configuration candidates without choosing a deployment', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'configuration-evidence-'));
  const files = [
    ['src/main/resources/application-prod.yaml', 'yaml', 'messaging:\n  topic: ${TOPIC_NAME:orders.default}\n'],
    ['deploy/chart/values.yaml', 'yaml', 'messaging:\n  topic: orders.helm\n'],
    ['deploy/chart/templates/deployment.yaml', 'yaml', 'topic: {{ .Values.messaging.topic }}\n'],
    ['deploy/k8s/deployment.yaml', 'yaml', [
      'apiVersion: apps/v1',
      'kind: Deployment',
      'metadata:',
      '  name: neutral-worker',
      'spec:',
      '  template:',
      '    spec:',
      '      containers:',
      '        - name: worker',
      '          env:',
      '            - name: TOPIC_NAME',
      '              valueFrom:',
      '                configMapKeyRef:',
      '                  name: runtime-settings',
      '                  key: topic-name',
      '            - name: API_TOKEN',
      '              valueFrom:',
      '                secretKeyRef:',
      '                  name: runtime-secret',
      '                  key: token',
    ].join('\n')],
  ] as const;
  const batch = emptyRepositoryInventoryBatch();
  batch.runs.push({ id: 'inventory', workspacePath: root, status: 'complete', documentCount: files.length, declarationCount: 0 });
  for (const [relativePath, languageId, content] of files) {
    const file = path.join(root, relativePath);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
    batch.documents.push({
      id: repositoryStableId('document', relativePath), runId: 'inventory', path: file, relativePath,
      languageId, kind: 'configuration', contentHash: 'fixture', byteSize: content.length,
      lineCount: content.split('\n').length, codeOrigin: 'repository', providerId: 'fixture',
      providerVersion: '1', authority: 'structural_lexical',
    });
  }

  await addConfigurationEvidence(batch, {
    sources: ['spring', 'kubernetes', 'helm'], activeProfiles: [], helmValuesFiles: [],
  });

  const spring = batch.configurationValues.find((value) => value.key === 'messaging.topic' && value.sourceKind === 'spring');
  assert.equal(spring?.status, 'symbolic');
  assert.equal(spring?.resolvedValue, 'orders.default');
  assert.equal(spring?.profile, 'prod');
  assert.ok(batch.configurationValues.some((value) => value.rawValue === 'orders.helm'));
  assert.ok(batch.configurationReferences.some((value) => value.kind === 'helm-value' && value.targetKey === 'messaging.topic'));
  assert.ok(batch.configurationReferences.some((value) => value.kind === 'config-map' && value.targetKey === 'runtime-settings.topic-name'));
  assert.ok(
    batch.configurationReferences.some((value) => value.kind === 'secret' && value.targetKey === 'runtime-secret.token'),
    JSON.stringify({ values: batch.configurationValues, references: batch.configurationReferences }, null, 2),
  );
  assert.ok(batch.deploymentUnits.some((value) => value.kind === 'Deployment' && value.name === 'neutral-worker'));
  assert.ok(batch.configurationValues.filter((value) => value.key === 'TOPIC_NAME').length === 1);
});
