#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const fixtureRoot = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUTPUT = path.join(fixtureRoot, 'workspace');
const DEFAULT_SOURCES = 5_000;
const DEFAULT_PACKAGES = 500;
const PLATFORM_SOURCES = 20;
const MARKER = '.synthetic-bazel-sample.json';

const CATEGORY_PLAN = [
  { name: 'libraries', packages: 250, binary: false, platform: 'framework_bundle' },
  { name: 'services', packages: 150, binary: true, platform: 'cloud_bundle' },
  { name: 'workflows', packages: 60, binary: false, platform: 'workflow_bundle' },
  { name: 'simulators', packages: 40, binary: true, platform: 'framework_bundle' },
];

export function createScalePlan(sourceCount = DEFAULT_SOURCES, packageCount = DEFAULT_PACKAGES) {
  requireInteger(sourceCount, 'sources');
  requireInteger(packageCount, 'packages');
  if (packageCount !== DEFAULT_PACKAGES) {
    throw new Error(`packages must be ${DEFAULT_PACKAGES}; the category proportions are part of this fixture`);
  }
  const minimum = PLATFORM_SOURCES + packageCount * 3;
  if (sourceCount < minimum) {
    throw new Error(`sources must be at least ${minimum} so every package has production, test, and optional launcher code`);
  }
  const distributable = sourceCount - PLATFORM_SOURCES;
  const perPackage = Math.floor(distributable / packageCount);
  const remainder = distributable % packageCount;
  const components = [];
  let ordinal = 0;
  for (const category of CATEGORY_PLAN) {
    for (let categoryIndex = 0; categoryIndex < category.packages; categoryIndex += 1) {
      const documents = perPackage + (ordinal < remainder ? 1 : 0);
      components.push({ ...category, categoryIndex, ordinal, documents });
      ordinal += 1;
    }
  }
  return {
    schemaVersion: 1,
    sourceCount,
    packageCount,
    platformSources: PLATFORM_SOURCES,
    components,
    categories: CATEGORY_PLAN.map(({ name, packages }) => ({ name, packages })),
  };
}

export function generateScaleFixture(outputPath = DEFAULT_OUTPUT, options = {}) {
  const plan = createScalePlan(options.sourceCount, options.packageCount);
  const output = path.resolve(outputPath);
  prepareOutput(output);
  writeRootFiles(output, plan);
  writePlatformLayer(output);
  for (const component of plan.components) writeComponent(output, component, plan.components);
  fs.writeFileSync(path.join(output, MARKER), `${JSON.stringify({
    ...plan,
    components: undefined,
  }, null, 2)}\n`);
  initializeGitIndex(output);
  return validateScaleFixture(output, plan);
}

export function validateScaleFixture(outputPath, expectedPlan) {
  const output = path.resolve(outputPath);
  const markerPath = path.join(output, MARKER);
  if (!fs.existsSync(markerPath)) throw new Error(`generated fixture marker is missing: ${markerPath}`);
  const javaFiles = walkFiles(output, (name) => name.endsWith('.java'));
  const buildFiles = walkFiles(output, (name) => name === 'BUILD.bazel');
  if (javaFiles.length !== expectedPlan.sourceCount) {
    throw new Error(`expected ${expectedPlan.sourceCount} Java files, found ${javaFiles.length}`);
  }
  if (buildFiles.length !== expectedPlan.packageCount + 4) {
    throw new Error(`expected ${expectedPlan.packageCount + 4} BUILD files, found ${buildFiles.length}`);
  }
  return {
    output,
    javaFiles: javaFiles.length,
    buildFiles: buildFiles.length,
    componentPackages: expectedPlan.packageCount,
    categories: expectedPlan.categories,
  };
}

function writeRootFiles(output, plan) {
  write(output, '.bazelversion', '7.6.1\n');
  write(output, '.gitignore', [
    '/.gitnexus/',
    '/bazel-*',
    '/MODULE.bazel.lock',
    '*.lbug',
    '',
  ].join('\n'));
  write(output, '.bazelrc', [
    'build --java_language_version=21',
    'build --tool_java_language_version=21',
    'build --strict_java_deps=error',
    'test --test_output=errors',
    '',
  ].join('\n'));
  write(output, 'MODULE.bazel', [
    'module(name = "layered_java_scale_sample", version = "1.0.0")',
    '',
    'bazel_dep(name = "rules_java", version = "9.2.0")',
    '',
  ].join('\n'));
  write(output, 'BUILD.bazel', [
    'load("@rules_java//java:java_library.bzl", "java_library")',
    '',
    'package(default_visibility = ["//visibility:public"])',
    '',
    'java_library(',
    '    name = "coverage-summary",',
    '    tags = ["coverage", "reporting-only", "manual"],',
    ')',
    '',
    'java_library(',
    '    name = "dependency-report",',
    '    tags = ["reporting-only", "manual"],',
    ')',
    '',
    'filegroup(',
    '    name = "all-component-build-files",',
    '    srcs = glob(["components/**/BUILD.bazel"]),',
    ')',
    '',
  ].join('\n'));
  write(output, 'sample-size.json', `${JSON.stringify({
    javaDocuments: plan.sourceCount,
    componentPackages: plan.packageCount,
    platformJavaDocuments: plan.platformSources,
    categories: plan.categories,
  }, null, 2)}\n`);
}

function writePlatformLayer(output) {
  const bundles = [
    ['framework', 'framework_bundle', 6],
    ['cloud', 'cloud_bundle', 6],
    ['workflow', 'workflow_bundle', 6],
  ];
  const build = [
    'load("@rules_java//java:java_library.bzl", "java_library")',
    '',
    'package(default_visibility = ["//visibility:public"])',
    '',
  ];
  for (const [directory, target] of bundles) {
    const dependency = target === 'framework_bundle' ? [] : ['        ":framework_bundle",'];
    build.push(
      'java_library(',
      `    name = "${target}",`,
      `    srcs = glob(["src/main/java/com/example/layered/platform/${directory}/**/*.java"]),`,
      ...(dependency.length ? ['    deps = [', ...dependency, '    ],'] : []),
      ')',
      '',
    );
    for (let index = 0; index < 6; index += 1) {
      const className = `${pascal(directory)}Capability${pad(index, 2)}`;
      writeJava(output, `build-platforms/dependencies/src/main/java/com/example/layered/platform/${directory}/${className}.java`, [
        `package com.example.layered.platform.${directory};`,
        '',
        `public final class ${className} {`,
        `    private ${className}() {}`, 
        `    public static String id() { return "${directory}-${index}"; }`,
        '}',
      ]);
    }
  }
  write(output, 'build-platforms/dependencies/BUILD.bazel', build.join('\n'));

  writeJava(output, 'build-platforms/plugins/src/main/java/com/example/layered/plugins/GeneratedMarker.java', [
    'package com.example.layered.plugins;',
    '',
    'public @interface GeneratedMarker {}',
  ]);
  writeJava(output, 'build-platforms/plugins/src/main/java/com/example/layered/plugins/SharedProcessor.java', [
    'package com.example.layered.plugins;',
    '',
    'import java.util.Set;',
    'import javax.annotation.processing.AbstractProcessor;',
    'import javax.annotation.processing.RoundEnvironment;',
    'import javax.lang.model.SourceVersion;',
    'import javax.lang.model.element.TypeElement;',
    '',
    'public final class SharedProcessor extends AbstractProcessor {',
    '    @Override public Set<String> getSupportedAnnotationTypes() { return Set.of("*"); }',
    '    @Override public SourceVersion getSupportedSourceVersion() { return SourceVersion.latestSupported(); }',
    '    @Override public boolean process(Set<? extends TypeElement> annotations, RoundEnvironment roundEnv) {',
    '        return false;',
    '    }',
    '}',
  ]);
  write(output, 'build-platforms/plugins/BUILD.bazel', [
    'load("@rules_java//java:java_library.bzl", "java_library")',
    'load("@rules_java//java:java_plugin.bzl", "java_plugin")',
    '',
    'package(default_visibility = ["//visibility:public"])',
    '',
    'java_library(',
    '    name = "processor-lib",',
    '    srcs = glob(["src/main/java/**/*.java"]),',
    ')',
    '',
    'java_plugin(',
    '    name = "shared_processor",',
    '    processor_class = "com.example.layered.plugins.SharedProcessor",',
    '    deps = [":processor-lib"],',
    ')',
    '',
  ].join('\n'));

  write(output, 'tools/build_defs/BUILD.bazel', [
    'exports_files(["layered_java.bzl"])',
    '',
  ].join('\n'));
  write(output, 'tools/build_defs/layered_java.bzl', macroSource());
}

function writeComponent(output, component, allComponents) {
  const id = pad(component.categoryIndex, 4);
  const target = `${singular(component.name)}_${id}`;
  const packageName = `com.example.layered.${component.name}.${target}`;
  const packagePath = `components/${component.name}/${target}`;
  const launcherCount = component.binary ? 1 : 0;
  const testCount = 1;
  const mainCount = component.documents - launcherCount - testCount;
  const previous = component.ordinal === 0 ? undefined : allComponents[component.ordinal - 1];
  const previousLabel = previous ? componentLabel(previous) : undefined;

  for (let index = 0; index < mainCount; index += 1) {
    const className = `${pascal(target)}Part${pad(index, 2)}`;
    writeJava(output, `${packagePath}/src/main/java/${packageName.replaceAll('.', '/')}/${className}.java`, [
      `package ${packageName};`,
      '',
      `public final class ${className} {`,
      `    private ${className}() {}`,
      `    public static String id() { return "${component.name}:${id}:${index}"; }`,
      `    public static int shard() { return ${component.ordinal}; }`,
      '}',
    ]);
  }

  const primaryClass = `${pascal(target)}Part00`;
  const testClass = `${pascal(target)}Test`;
  writeJava(output, `${packagePath}/src/test/java/${packageName.replaceAll('.', '/')}/${testClass}.java`, [
    `package ${packageName};`,
    '',
    `public final class ${testClass} {`,
    '    public static void main(String[] args) {',
    `        if (${primaryClass}.id().isEmpty()) throw new AssertionError("missing component id");`,
    '    }',
    '}',
  ]);

  let mainClass;
  if (component.binary) {
    mainClass = `${pascal(target)}Launcher`;
    writeJava(output, `${packagePath}/src/launcher/java/${packageName.replaceAll('.', '/')}/${mainClass}.java`, [
      `package ${packageName};`,
      '',
      `public final class ${mainClass} {`,
      '    private ' + mainClass + '() {}',
      '    public static void main(String[] args) {',
      `        System.out.println("${component.name}:${id}");`,
      '    }',
      '}',
    ]);
  }

  const tags = component.name === 'simulators'
    ? ['qa', 'simulator']
    : component.name === 'workflows' ? ['production', 'workflow'] : ['production', singular(component.name)];
  write(output, `${packagePath}/BUILD.bazel`, [
    'load("//tools/build_defs:layered_java.bzl", "layered_java_component")',
    '',
    'layered_java_component(',
    `    name = "${target}",`,
    `    main_srcs = glob(["src/main/java/**/*.java"]),`,
    `    test_srcs = glob(["src/test/java/**/*.java"]),`,
    ...(component.binary ? [
      '    launcher_srcs = glob(["src/launcher/java/**/*.java"]),',
      `    main_class = "${packageName}.${mainClass}",`,
    ] : []),
    `    test_class = "${packageName}.${testClass}",`,
    '    deps = [',
    `        "//build-platforms/dependencies:${component.platform}",`,
    ...(previousLabel ? [`        "${previousLabel}",`] : []),
    '    ],',
    `    tags = ${starlarkList(tags)},`,
    ')',
    '',
  ].join('\n'));
}

function componentLabel(component) {
  const id = pad(component.categoryIndex, 4);
  const target = `${singular(component.name)}_${id}`;
  return `//components/${component.name}/${target}:${target}`;
}

function macroSource() {
  return [
    'load("@rules_java//java:java_binary.bzl", "java_binary")',
    'load("@rules_java//java:java_library.bzl", "java_library")',
    'load("@rules_java//java:java_test.bzl", "java_test")',
    '',
    'def layered_java_component(name, main_srcs, test_srcs, test_class, deps = [], tags = [], launcher_srcs = [], main_class = None):',
    '    java_library(',
    '        name = name,',
    '        srcs = main_srcs,',
    '        deps = deps,',
    '        plugins = ["//build-platforms/plugins:shared_processor"],',
    '        tags = tags,',
    '        visibility = ["//visibility:public"],',
    '    )',
    '    if launcher_srcs:',
    '        java_binary(',
    '            name = name + "_application",',
    '            srcs = launcher_srcs,',
    '            main_class = main_class,',
    '            runtime_deps = [":" + name],',
    '            tags = tags + ["application"],',
    '        )',
    '    java_test(',
    '        name = name + "_test",',
    '        srcs = test_srcs,',
    '        main_class = test_class,',
    '        use_testrunner = False,',
    '        deps = [":" + name],',
    '        tags = tags + ["relevant-test"],',
    '    )',
    '    java_library(',
    '        name = name + "_deploy_bannedcheck",',
    '        deps = [":" + name],',
    '        tags = ["validation-only", "manual"],',
    '    )',
    '    java_library(',
    '        name = name + "-sonar",',
    '        deps = [":" + name],',
    '        tags = ["sonarqube", "reporting-only", "manual"],',
    '    )',
    '    java_library(',
    '        name = name + "-sq",',
    '        deps = [":" + name],',
    '        tags = ["sonarqube", "reporting-only", "manual"],',
    '    )',
    '    java_library(',
    '        name = name + "_coverage_report",',
    '        deps = [":" + name],',
    '        tags = ["coverage", "reporting-only", "manual"],',
    '    )',
    '    native.filegroup(',
    '        name = name + "_deploy",',
    '        srcs = [":" + name],',
    '        tags = ["deployment", "manual"],',
    '    )',
    '',
  ].join('\n');
}

function prepareOutput(output) {
  if (output === path.parse(output).root || output === fixtureRoot) {
    throw new Error(`refusing unsafe output path: ${output}`);
  }
  if (fs.existsSync(output)) {
    const generated = fs.existsSync(path.join(output, MARKER));
    const empty = fs.readdirSync(output).length === 0;
    if (!generated && !empty) {
      throw new Error(`refusing to replace an unmarked nonempty directory: ${output}`);
    }
    if (generated) fs.rmSync(output, { recursive: true, force: true });
  }
  fs.mkdirSync(output, { recursive: true });
}

function writeJava(output, relativePath, lines) {
  write(output, relativePath, `${lines.join('\n')}\n`);
}

function write(output, relativePath, content) {
  const destination = path.join(output, relativePath);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, content);
}

function initializeGitIndex(output) {
  try {
    execFileSync('git', ['init', '--quiet', '--initial-branch=main', output], { stdio: 'ignore' });
    execFileSync('git', ['-C', output, 'add', '--all'], { stdio: 'ignore' });
  } catch (error) {
    throw new Error(`unable to initialize the synthetic workspace Git index: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function walkFiles(root, predicate) {
  const found = [];
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const resolved = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(resolved);
      else if (entry.isFile() && predicate(entry.name)) found.push(resolved);
    }
  }
  return found.sort();
}

function parseArguments(argv) {
  const result = { output: DEFAULT_OUTPUT, sourceCount: DEFAULT_SOURCES, packageCount: DEFAULT_PACKAGES };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--output') result.output = requiredValue(argv, ++index, flag);
    else if (flag === '--sources') result.sourceCount = Number(requiredValue(argv, ++index, flag));
    else if (flag === '--packages') result.packageCount = Number(requiredValue(argv, ++index, flag));
    else throw new Error(`unknown argument: ${flag}`);
  }
  return result;
}

function requiredValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return value;
}

function requireInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
}

function singular(category) {
  return category === 'libraries' ? 'library'
    : category === 'services' ? 'service'
      : category === 'workflows' ? 'workflow' : 'simulator';
}

function pascal(value) {
  return value.split(/[_-]/).map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join('');
}

function pad(value, width) {
  return String(value).padStart(width, '0');
}

function starlarkList(values) {
  return `[${values.map((value) => `"${value}"`).join(', ')}]`;
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArguments(process.argv.slice(2));
    const result = generateScaleFixture(options.output, options);
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
