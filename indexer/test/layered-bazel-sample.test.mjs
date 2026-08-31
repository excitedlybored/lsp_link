import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import {
  createScalePlan,
  generateScaleFixture,
} from '../../sample_projects/bazel-layered-java-monorepo-5000/generate.mjs';

test('plans exactly 5,000 Java documents across the layered architecture', () => {
  const plan = createScalePlan();
  assert.equal(plan.sourceCount, 5_000);
  assert.equal(plan.packageCount, 500);
  assert.equal(plan.platformSources, 20);
  assert.equal(plan.components.reduce((sum, component) => sum + component.documents, 0), 4_980);
  assert.deepEqual(plan.categories, [
    { name: 'libraries', packages: 250 },
    { name: 'workflows', packages: 60 },
    { name: 'services', packages: 150 },
    { name: 'simulators', packages: 40 },
  ]);
});

test('materializes and validates the complete 5,000-document Bazel fixture', (t) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'layered-bazel-sample-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const result = generateScaleFixture(temporary);
  assert.equal(result.javaFiles, 5_000);
  assert.equal(result.buildFiles, 504);
  assert.equal(result.componentPackages, 500);
  assert.ok(fs.existsSync(path.join(temporary, 'MODULE.bazel')));
  assert.equal(fs.readFileSync(path.join(temporary, '.bazelversion'), 'utf8'), '7.6.1\n');
  assert.equal(
    execFileSync('git', ['-C', temporary, 'ls-files', '--cached', '--', '*.java'], { encoding: 'utf8' })
      .trim().split('\n').filter(Boolean).length,
    5_000,
  );
  assert.ok(fs.existsSync(path.join(temporary, 'build-platforms/plugins/BUILD.bazel')));
  assert.equal(
    execFileSync('git', ['-C', temporary, 'grep', '-l', '@WorkflowInterface', '--', 'components/workflows'], { encoding: 'utf8' })
      .trim().split('\n').filter(Boolean).length,
    60,
  );
  assert.equal(
    execFileSync('git', ['-C', temporary, 'grep', '-l', 'newWorkflowStub', '--', 'components/services'], { encoding: 'utf8' })
      .trim().split('\n').filter(Boolean).length,
    150,
  );
  assert.equal(
    execFileSync('git', ['-C', temporary, 'grep', '-l', 'simulated cancellation', '--', 'components/simulators'], { encoding: 'utf8' })
      .trim().split('\n').filter(Boolean).length,
    40,
  );
  assert.equal(
    execFileSync('git', ['-C', temporary, 'grep', '-l', 'newChildWorkflowStub', '--', 'components/workflows'], { encoding: 'utf8' })
      .trim().split('\n').filter(Boolean).length,
    60,
  );
  assert.equal(
    execFileSync('git', ['-C', temporary, 'grep', '-l', 'compensateFailure', '--', 'components/workflows'], { encoding: 'utf8' })
      .trim().split('\n').filter(Boolean).length,
    60,
  );
  assert.equal(
    execFileSync('git', ['-C', temporary, 'grep', '-l', 'workflow.adjustAmount', '--', 'components/simulators'], { encoding: 'utf8' })
      .trim().split('\n').filter(Boolean).length,
    40,
  );
  assert.ok(fs.existsSync(path.join(
    temporary, 'build-platforms/dependencies/src/main/java/io/temporal/workflow/WorkflowInterface.java',
  )));
  assert.match(
    fs.readFileSync(path.join(temporary, 'tools/build_defs/layered_java.bzl'), 'utf8'),
    /name \+ "_deploy_bannedcheck"/,
  );
});

test('refuses to replace an unmarked nonempty output directory', (t) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'layered-bazel-safety-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  fs.writeFileSync(path.join(temporary, 'keep.txt'), 'user-owned\n');
  assert.throws(() => generateScaleFixture(temporary), /refusing to replace an unmarked nonempty directory/);
  assert.equal(fs.readFileSync(path.join(temporary, 'keep.txt'), 'utf8'), 'user-owned\n');
});
