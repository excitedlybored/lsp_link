import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { parseBazelPreparationCommandOptions } from '../src/cli/bazel-prepare.js';
import { parseLspKnowledgeGraphBuildOptions } from '../src/pipeline/cli-options.js';
import { extractRunConfig, loadRunConfig } from '../src/pipeline/run-config.js';

const TRACKED_DEFAULT_CONFIG = fileURLToPath(new URL('../../config/default.json', import.meta.url));
const SCALE_SAMPLE_CONFIG = fileURLToPath(new URL(
  '../../sample_projects/bazel-layered-java-monorepo-5000/index-config.json',
  import.meta.url,
));

type JsonObject = Record<string, any>;

function completeConfig(): JsonObject {
  return {
    schemaVersion: 1,
    name: 'core-java',
    bazel: {
      buildModelMode: 'prepared',
      scope: {
        includeTargetPatterns: ['//service/...', '//...'],
        includeRuleKinds: ['java_test', 'java_library', 'java_binary'],
        explicitTargets: ['//simulator:custom_java'],
        excludeTargetNamePatterns: ['.*-sonar$', '.*_deploy_bannedcheck$'],
        excludeLabels: ['//example:excluded_report'],
        excludeTags: ['reporting-only', 'coverage'],
      },
      preparation: { concurrency: 3, timeoutMs: 9000 },
    },
    crawl: { profile: 'core', javaSemantics: 'batch', concurrency: 2, jdtProcesses: 1, resume: false },
    artifacts: {
      concurrency: 5,
      maxClasses: 1200,
      fetchSources: false,
      classpathManifests: ['manifests/runtime.json', '/opt/shared/compile.json'],
    },
    quality: { failOnFailedBuildRoot: false },
    checkpoints: { directory: 'checkpoints' },
  };
}

function minimalConfig(): JsonObject {
  return {
    schemaVersion: 1,
    bazel: {
      scope: {
        includeTargetPatterns: ['//...'],
        includeRuleKinds: ['java_library'],
      },
    },
  };
}

function configFile(
  value: unknown = completeConfig(),
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-run-config-')),
): string {
  const filename = path.join(directory, 'run.json');
  fs.writeFileSync(filename, JSON.stringify(value));
  return filename;
}

function mutated(change: (value: JsonObject) => void): string {
  const value = completeConfig();
  change(value);
  return configFile(value);
}

test('loads the tracked polyglot default without repository-specific labels', () => {
  const config = loadRunConfig(TRACKED_DEFAULT_CONFIG);
  assert.equal(config.name, 'default-index');
  assert.equal(config.bazel.buildModelMode, 'prepared');
  assert.equal(config.crawl.profile, 'core');
  assert.equal(config.crawl.javaSemantics, 'batch');
  assert.deepEqual(config.bazel.scope.includeTargetPatterns, ['//...']);
  assert.deepEqual(config.bazel.scope.includeRuleKinds, [
    'java_binary',
    'java_library',
    'java_test',
    'kt_jvm_binary',
    'kt_jvm_library',
    'kt_jvm_test',
  ]);
  assert.deepEqual(config.bazel.scope.excludeLabels, []);
  assert.equal(config.quality.failOnFailedBuildRoot, true);
});

test('loads every explicit version-1 config field', () => {
  const filename = configFile();
  const directory = path.dirname(filename);
  const config = loadRunConfig(filename);

  assert.equal(config.schemaVersion, 1);
  assert.equal(config.name, 'core-java');
  assert.equal(config.path, filename);
  assert.match(config.semanticHash, /^[a-f0-9]{64}$/);
  assert.equal(config.bazel.buildModelMode, 'prepared');
  assert.deepEqual(config.bazel.scope, {
    includeTargetPatterns: ['//...', '//service/...'],
    includeRuleKinds: ['java_binary', 'java_library', 'java_test'],
    explicitTargets: ['//simulator:custom_java'],
    excludeTargetNamePatterns: ['.*-sonar$', '.*_deploy_bannedcheck$'],
    excludeLabels: ['//example:excluded_report'],
    excludeTags: ['coverage', 'reporting-only'],
  });
  assert.deepEqual(config.bazel.preparation, { concurrency: 3, timeoutMs: 9000 });
  assert.deepEqual(config.crawl, {
    profile: 'core', javaSemantics: 'batch', concurrency: 2, jdtProcesses: 1, resume: false,
  });
  assert.deepEqual(config.artifacts, {
    concurrency: 5,
    maxClasses: 1200,
    fetchSources: false,
    classpathManifests: ['/opt/shared/compile.json', path.join(directory, 'manifests/runtime.json')],
  });
  assert.deepEqual(config.quality, { failOnFailedBuildRoot: false });
  assert.deepEqual(config.checkpoints, { directory: path.join(directory, 'checkpoints') });
});

test('applies every omitted-field default', () => {
  const config = loadRunConfig(configFile(minimalConfig()));

  assert.equal(config.name, 'default');
  assert.equal(config.bazel.buildModelMode, 'integrated');
  assert.deepEqual(config.bazel.scope, {
    includeTargetPatterns: ['//...'],
    includeRuleKinds: ['java_library'],
    explicitTargets: [],
    excludeTargetNamePatterns: [],
    excludeLabels: [],
    excludeTags: [],
  });
  assert.deepEqual(config.bazel.preparation, { concurrency: 4, timeoutMs: 600_000 });
  assert.deepEqual(config.crawl, {
    profile: 'exhaustive', javaSemantics: 'batch', concurrency: 4, jdtProcesses: 1, resume: true,
  });
  assert.deepEqual(config.artifacts, {
    concurrency: 4,
    maxClasses: undefined,
    fetchSources: true,
    classpathManifests: [],
  });
  assert.deepEqual(config.quality, { failOnFailedBuildRoot: true });
  assert.deepEqual(config.checkpoints, { directory: undefined });
});

test('maps legacy build-mode names and rejects mixing legacy and indicative fields', () => {
  const legacy = completeConfig();
  delete legacy.bazel.buildModelMode;
  legacy.bazel.buildMode = 'prebuilt';
  assert.equal(loadRunConfig(configFile(legacy)).bazel.buildModelMode, 'prepared');
  legacy.bazel.buildModelMode = 'prepared';
  assert.throws(
    () => loadRunConfig(configFile(legacy)),
    /cannot contain both buildModelMode and legacy buildMode/,
  );
});

test('accepts all enum values, nullable fields, and numeric boundaries', () => {
  const value = completeConfig();
  value.bazel.buildModelMode = 'integrated';
  value.bazel.preparation.concurrency = 1;
  value.bazel.preparation.timeoutMs = 1;
  value.crawl.profile = 'exhaustive';
  value.crawl.concurrency = 1;
  value.crawl.jdtProcesses = 2;
  value.artifacts.concurrency = 16;
  value.artifacts.maxClasses = null;
  value.checkpoints.directory = null;
  const config = loadRunConfig(configFile(value));

  assert.equal(config.bazel.buildModelMode, 'integrated');
  assert.equal(config.bazel.preparation.concurrency, 1);
  assert.equal(config.bazel.preparation.timeoutMs, 1);
  assert.equal(config.crawl.profile, 'exhaustive');
  assert.equal(config.crawl.concurrency, 1);
  assert.equal(config.crawl.jdtProcesses, 2);
  assert.equal(config.artifacts.concurrency, 16);
  assert.equal(config.artifacts.maxClasses, undefined);
  assert.equal(config.checkpoints.directory, undefined);
});

test('sorts and deduplicates every scope selector array', () => {
  const value = minimalConfig();
  value.bazel.scope = {
    includeTargetPatterns: ['//z/...', '//a/...', '//z/...'],
    includeRuleKinds: ['java_test', 'java_library', 'java_test'],
    explicitTargets: ['//z:lib', '//a:lib', '//z:lib'],
    excludeTargetNamePatterns: ['z$', 'a$', 'z$'],
    excludeLabels: ['//z:skip', '//a:skip', '//z:skip'],
    excludeTags: ['slow', 'coverage', 'slow'],
  };
  assert.deepEqual(loadRunConfig(configFile(value)).bazel.scope, {
    includeTargetPatterns: ['//a/...', '//z/...'],
    includeRuleKinds: ['java_library', 'java_test'],
    explicitTargets: ['//a:lib', '//z:lib'],
    excludeTargetNamePatterns: ['a$', 'z$'],
    excludeLabels: ['//a:skip', '//z:skip'],
    excludeTags: ['coverage', 'slow'],
  });
});

test('allows an explicit-only scope and rejects an empty or conflicting scope', () => {
  const explicitOnly = minimalConfig();
  explicitOnly.bazel.scope.includeTargetPatterns = [];
  explicitOnly.bazel.scope.includeRuleKinds = [];
  explicitOnly.bazel.scope.explicitTargets = ['//custom:java'];
  assert.deepEqual(loadRunConfig(configFile(explicitOnly)).bazel.scope.explicitTargets, ['//custom:java']);

  assert.throws(() => loadRunConfig(mutated((value) => {
    value.bazel.scope.includeTargetPatterns = [];
    value.bazel.scope.explicitTargets = [];
  })), /requires includeTargetPatterns or explicitTargets/);
  assert.throws(() => loadRunConfig(mutated((value) => {
    value.bazel.scope.explicitTargets = ['//same:target'];
    value.bazel.scope.excludeLabels = ['//same:target'];
  })), /Explicit target is also excluded/);
});

test('operational fields do not change the semantic hash', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-run-config-hash-'));
  const baseline = loadRunConfig(configFile(completeConfig(), directory)).semanticHash;
  const value = completeConfig();
  value.bazel.preparation = { concurrency: 8, timeoutMs: 123_456 };
  value.crawl.concurrency = 7;
  value.crawl.jdtProcesses = 3;
  value.crawl.resume = true;
  value.artifacts.concurrency = 9;
  value.quality.failOnFailedBuildRoot = true;
  value.checkpoints.directory = 'different-checkpoints';
  const changed = loadRunConfig(configFile(value, directory)).semanticHash;
  assert.equal(changed, baseline);
});

test('each semantic field changes the semantic hash', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-run-config-semantic-'));
  const baseline = loadRunConfig(configFile(completeConfig(), directory)).semanticHash;
  const changes: Array<[string, (value: JsonObject) => void]> = [
    ['name', (value) => { value.name = 'another-run'; }],
    ['bazel.buildModelMode', (value) => { value.bazel.buildModelMode = 'integrated'; }],
    ['scope.includeTargetPatterns', (value) => { value.bazel.scope.includeTargetPatterns = ['//app/...']; }],
    ['scope.includeRuleKinds', (value) => { value.bazel.scope.includeRuleKinds = ['java_library']; }],
    ['scope.explicitTargets', (value) => { value.bazel.scope.explicitTargets = ['//app:custom']; }],
    ['scope.excludeTargetNamePatterns', (value) => { value.bazel.scope.excludeTargetNamePatterns = []; }],
    ['scope.excludeLabels', (value) => { value.bazel.scope.excludeLabels = []; }],
    ['scope.excludeTags', (value) => { value.bazel.scope.excludeTags = []; }],
    ['crawl.profile', (value) => { value.crawl.profile = 'exhaustive'; }],
    ['crawl.javaSemantics', (value) => { value.crawl.javaSemantics = 'lsp'; }],
    ['artifacts.maxClasses', (value) => { value.artifacts.maxClasses = 1; }],
    ['artifacts.fetchSources', (value) => { value.artifacts.fetchSources = true; }],
    ['artifacts.classpathManifests', (value) => { value.artifacts.classpathManifests = []; }],
  ];
  for (const [field, change] of changes) {
    const value = completeConfig();
    change(value);
    assert.notEqual(loadRunConfig(configFile(value, directory)).semanticHash, baseline, field);
  }
});

test('rejects unsupported schema, missing required objects, and malformed JSON', () => {
  assert.throws(() => loadRunConfig(configFile({ ...minimalConfig(), schemaVersion: 2 })), /schemaVersion/);
  assert.throws(() => loadRunConfig(configFile({ schemaVersion: 1 })), /config\.bazel must be an object/);
  assert.throws(() => loadRunConfig(configFile({ schemaVersion: 1, bazel: {} })), /config\.bazel\.scope must be an object/);
  const malformed = configFile();
  fs.writeFileSync(malformed, '{');
  assert.throws(() => loadRunConfig(malformed), /Cannot read JSON run config/);
  assert.throws(() => loadRunConfig(`${malformed}.missing`), /Cannot read JSON run config/);
});

test('rejects invalid name, enums, booleans, regexes, and paths', () => {
  const cases: Array<[string, (value: JsonObject) => void, RegExp]> = [
    ['name', (value) => { value.name = ''; }, /config\.name must be a non-empty string/],
    ['buildModelMode', (value) => { value.bazel.buildModelMode = 'automatic'; }, /config\.bazel\.buildModelMode must be one of/],
    ['profile', (value) => { value.crawl.profile = 'fast'; }, /config\.crawl\.profile must be one of/],
    ['resume', (value) => { value.crawl.resume = 'yes'; }, /config\.crawl\.resume must be boolean/],
    ['fetchSources', (value) => { value.artifacts.fetchSources = 1; }, /config\.artifacts\.fetchSources must be boolean/],
    ['failOnFailedBuildRoot', (value) => { value.quality.failOnFailedBuildRoot = null; }, /config\.quality\.failOnFailedBuildRoot must be boolean/],
    ['target regex', (value) => { value.bazel.scope.excludeTargetNamePatterns = ['[']; }, /Invalid target-name regex/],
    ['checkpoint directory', (value) => { value.checkpoints.directory = ''; }, /config\.checkpoints\.directory must be a non-empty string/],
  ];
  for (const [field, change, expected] of cases) {
    assert.throws(() => loadRunConfig(mutated(change)), expected, field);
  }
});

test('rejects null for every non-nullable optional field', () => {
  const cases: Array<[string, (value: JsonObject) => void]> = [
    ['name', (value) => { value.name = null; }],
    ['bazel.buildModelMode', (value) => { value.bazel.buildModelMode = null; }],
    ['bazel.preparation', (value) => { value.bazel.preparation = null; }],
    ['bazel.preparation.concurrency', (value) => { value.bazel.preparation.concurrency = null; }],
    ['bazel.preparation.timeoutMs', (value) => { value.bazel.preparation.timeoutMs = null; }],
    ['scope.includeTargetPatterns', (value) => { value.bazel.scope.includeTargetPatterns = null; }],
    ['scope.includeRuleKinds', (value) => { value.bazel.scope.includeRuleKinds = null; }],
    ['scope.explicitTargets', (value) => { value.bazel.scope.explicitTargets = null; }],
    ['scope.excludeTargetNamePatterns', (value) => { value.bazel.scope.excludeTargetNamePatterns = null; }],
    ['scope.excludeLabels', (value) => { value.bazel.scope.excludeLabels = null; }],
    ['scope.excludeTags', (value) => { value.bazel.scope.excludeTags = null; }],
    ['crawl', (value) => { value.crawl = null; }],
    ['crawl.profile', (value) => { value.crawl.profile = null; }],
    ['crawl.concurrency', (value) => { value.crawl.concurrency = null; }],
    ['crawl.resume', (value) => { value.crawl.resume = null; }],
    ['artifacts', (value) => { value.artifacts = null; }],
    ['artifacts.concurrency', (value) => { value.artifacts.concurrency = null; }],
    ['artifacts.fetchSources', (value) => { value.artifacts.fetchSources = null; }],
    ['artifacts.classpathManifests', (value) => { value.artifacts.classpathManifests = null; }],
    ['quality', (value) => { value.quality = null; }],
    ['quality.failOnFailedBuildRoot', (value) => { value.quality.failOnFailedBuildRoot = null; }],
    ['checkpoints', (value) => { value.checkpoints = null; }],
  ];
  for (const [field, change] of cases) {
    assert.throws(() => loadRunConfig(mutated(change)), /./, field);
  }
});

test('rejects invalid numeric values for every numeric field', () => {
  const cases: Array<[string, (value: JsonObject) => void]> = [
    ['bazel.preparation.concurrency', (value) => { value.bazel.preparation.concurrency = 0; }],
    ['bazel.preparation.timeoutMs', (value) => { value.bazel.preparation.timeoutMs = 1.5; }],
    ['crawl.concurrency', (value) => { value.crawl.concurrency = -1; }],
    ['crawl.jdtProcesses', (value) => { value.crawl.jdtProcesses = 0; }],
    ['artifacts.concurrency lower bound', (value) => { value.artifacts.concurrency = 0; }],
    ['artifacts.concurrency upper bound', (value) => { value.artifacts.concurrency = 17; }],
    ['artifacts.maxClasses', (value) => { value.artifacts.maxClasses = 0; }],
  ];
  for (const [field, change] of cases) {
    assert.throws(() => loadRunConfig(mutated(change)), /must be an integer/, field);
  }
});

test('rejects invalid values for every scope and manifest array field', () => {
  const fields = [
    'includeTargetPatterns', 'includeRuleKinds', 'explicitTargets',
    'excludeTargetNamePatterns', 'excludeLabels', 'excludeTags',
  ];
  for (const field of fields) {
    assert.throws(() => loadRunConfig(mutated((value) => {
      value.bazel.scope[field] = ['valid', ''];
    })), new RegExp(`config\\.bazel\\.scope\\.${field} must be an array`), field);
  }
  assert.throws(() => loadRunConfig(mutated((value) => {
    value.artifacts.classpathManifests = ['valid.json', 3];
  })), /config\.artifacts\.classpathManifests must be an array/);
});

test('rejects unknown keys at every object level', () => {
  const cases: Array<[string, (value: JsonObject) => void, RegExp]> = [
    ['top level', (value) => { value.unexpected = true; }, /config contains unknown keys/],
    ['bazel', (value) => { value.bazel.unexpected = true; }, /config\.bazel contains unknown keys/],
    ['scope', (value) => { value.bazel.scope.unexpected = true; }, /config\.bazel\.scope contains unknown keys/],
    ['preparation', (value) => { value.bazel.preparation.unexpected = true; }, /config\.bazel\.preparation contains unknown keys/],
    ['crawl', (value) => { value.crawl.unexpected = true; }, /config\.crawl contains unknown keys/],
    ['artifacts', (value) => { value.artifacts.unexpected = true; }, /config\.artifacts contains unknown keys/],
    ['quality', (value) => { value.quality.unexpected = true; }, /config\.quality contains unknown keys/],
    ['checkpoints', (value) => { value.checkpoints.unexpected = true; }, /config\.checkpoints contains unknown keys/],
  ];
  for (const [level, change, expected] of cases) {
    assert.throws(() => loadRunConfig(mutated(change)), expected, level);
  }
});

test('extracts one config argument in any position and rejects malformed uses', () => {
  const filename = configFile();
  const extracted = extractRunConfig(['build-index', '--config', filename, '/workspace', '--output', '/tmp/run.lbug']);
  assert.deepEqual(extracted.args, ['build-index', '/workspace', '--output', '/tmp/run.lbug']);
  assert.equal(extracted.config?.path, filename);
  assert.deepEqual(extractRunConfig(['build', '/workspace']), { args: ['build', '/workspace'] });
  assert.throws(() => extractRunConfig(['build', '--config']), /--config requires a value/);
  assert.throws(() => extractRunConfig(['build', '--config', filename, '--config', filename]), /only once/);
});

test('maps every config field used by the build command', () => {
  const filename = configFile();
  const config = loadRunConfig(filename);
  const options = parseLspKnowledgeGraphBuildOptions(['build-index', '/workspace', '--config', filename]);

  assert.equal(options.bazelBuildMode, config.bazel.buildModelMode === 'prepared' ? 'prebuilt' : 'managed');
  assert.deepEqual(options.bazelTargetScope, config.bazel.scope);
  assert.equal(options.runConfigPath, config.path);
  assert.equal(options.runConfigHash, config.semanticHash);
  assert.equal(options.bazelPreparationConcurrency, config.bazel.preparation.concurrency);
  assert.equal(options.bazelPreparationTimeoutMs, config.bazel.preparation.timeoutMs);
  assert.equal(options.crawlProfile, config.crawl.profile);
  assert.equal(options.javaSemantics, config.crawl.javaSemantics);
  assert.equal(options.concurrency, config.crawl.concurrency);
  assert.equal(options.jdtProcesses, config.crawl.jdtProcesses);
  assert.equal(options.resume, config.crawl.resume);
  assert.equal(options.artifactConcurrency, config.artifacts.concurrency);
  assert.equal(options.artifactMaxClasses, config.artifacts.maxClasses);
  assert.equal(options.fetchArtifactSources, config.artifacts.fetchSources);
  assert.deepEqual(options.artifactManifestPaths, config.artifacts.classpathManifests);
  assert.equal(options.checkpointDirectory, config.checkpoints.directory);
  assert.equal(options.failOnFailedBuildRoot, config.quality.failOnFailedBuildRoot);
});

test('allows every operational build override with config', () => {
  const filename = configFile();
  const options = parseLspKnowledgeGraphBuildOptions([
    'build-index', '/workspace', '--config', filename,
    '--output', '/tmp/result.lbug', '--concurrency', '7', '--jdt-processes', '2', '--artifact-concurrency', '8',
    '--checkpoint-directory', '/tmp/checkpoints', '--no-resume',
  ]);
  assert.equal(options.output, '/tmp/result.lbug');
  assert.equal(options.concurrency, 7);
  assert.equal(options.jdtProcesses, 2);
  assert.equal(options.artifactConcurrency, 8);
  assert.equal(options.checkpointDirectory, '/tmp/checkpoints');
  assert.equal(options.resume, false);
});

test('allows crawl-only parity mode to override Java semantic providers with config', () => {
  const filename = configFile();
  const options = parseLspKnowledgeGraphBuildOptions([
    'crawl', '/workspace', '--config', filename,
    '--profile', 'exhaustive', '--java-semantics', 'lsp',
  ]);
  assert.equal(options.crawlProfile, 'exhaustive');
  assert.equal(options.javaSemantics, 'lsp');
});

test('rejects every semantic build override with config', () => {
  const filename = configFile();
  const cases: string[][] = [
    ['--artifact-max-classes', '2'],
    ['--build-model-mode', 'integrated'],
    ['--bazel-target-query', '//app:lib'],
    ['--no-artifact-source-fetch'],
    ['--artifact-classpath-manifest', '/tmp/classes.json'],
  ];
  for (const cli of cases) {
    assert.throws(() => parseLspKnowledgeGraphBuildOptions([
      'build-index', '/workspace', '--config', filename, ...cli,
    ]), /cannot override semantic settings/, cli[0]);
  }
});

test('maps config into build-model preparation and allows only its operational overrides', () => {
  const filename = configFile();
  const config = loadRunConfig(filename);
  const configured = parseBazelPreparationCommandOptions(['prepare-build-model', '/workspace', '--config', filename]);
  assert.equal(configured.concurrency, 3);
  assert.equal(configured.timeoutMs, 9000);
  assert.deepEqual(configured.targetScope, config.bazel.scope);
  assert.equal(configured.scopeConfigHash, config.semanticHash);
  assert.equal(configured.targetQuery, undefined);

  const overridden = parseBazelPreparationCommandOptions([
    'prepare-build-model', '/workspace', '--config', filename, '--concurrency', '7', '--timeout-ms', '12000',
  ]);
  assert.equal(overridden.concurrency, 7);
  assert.equal(overridden.timeoutMs, 12000);
  assert.throws(() => parseBazelPreparationCommandOptions([
    'prepare-build-model', '/workspace', '--config', filename, '--bazel-target-query', '//app:lib',
  ]), /cannot override semantic settings/);
});

test('loads the 5,000-document layered Bazel sample policy', () => {
  const config = loadRunConfig(SCALE_SAMPLE_CONFIG);
  assert.equal(config.name, 'layered-java-5000');
  assert.equal(config.bazel.buildModelMode, 'prepared');
  assert.equal(config.bazel.preparation.timeoutMs, 3_600_000);
  assert.equal(config.crawl.profile, 'core');
  assert.deepEqual(config.bazel.scope.includeRuleKinds, ['java_binary', 'java_library', 'java_test']);
  assert.deepEqual(config.bazel.scope.excludeLabels, ['//:coverage-summary', '//:dependency-report']);
  assert.deepEqual(config.bazel.scope.excludeTags, ['coverage', 'reporting-only']);
});
