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
  { name: 'workflows', packages: 60, binary: false, platform: 'workflow_bundle' },
  { name: 'services', packages: 150, binary: true, platform: 'cloud_bundle' },
  { name: 'simulators', packages: 40, binary: true, platform: 'framework_bundle' },
];

export function createScalePlan(sourceCount = DEFAULT_SOURCES, packageCount = DEFAULT_PACKAGES) {
  requireInteger(sourceCount, 'sources');
  requireInteger(packageCount, 'packages');
  if (packageCount !== DEFAULT_PACKAGES) {
    throw new Error(`packages must be ${DEFAULT_PACKAGES}; the category proportions are part of this fixture`);
  }
  const minimum = DEFAULT_SOURCES;
  if (sourceCount < minimum) {
    throw new Error(`sources must be at least ${minimum} so the Temporal architecture and every component remain complete`);
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
    ['framework', 'framework_bundle', 3],
    ['cloud', 'cloud_bundle', 3],
  ];
  const build = [
    'load("@rules_java//java:java_library.bzl", "java_library")',
    '',
    'package(default_visibility = ["//visibility:public"])',
    '',
  ];
  for (const [directory, target, sourceCount] of bundles) {
    const dependency = target === 'framework_bundle' ? [] : ['        ":framework_bundle",'];
    build.push(
      'java_library(',
      `    name = "${target}",`,
      `    srcs = glob(["src/main/java/com/example/layered/platform/${directory}/**/*.java"]),`,
      ...(dependency.length ? ['    deps = [', ...dependency, '    ],'] : []),
      ')',
      '',
    );
    for (let index = 0; index < sourceCount; index += 1) {
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
  build.push(
    'java_library(',
    '    name = "workflow_bundle",',
    '    srcs = glob(["src/main/java/io/temporal/**/*.java"]),',
    '    deps = [":framework_bundle"],',
    ')',
    '',
  );
  writeTemporalSdk(output);
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

  if (component.name === 'workflows') {
    writeWorkflowSources(output, packagePath, packageName, target, id, mainCount);
  } else {
    const specialized = component.name === 'services' || component.name === 'simulators' ? 1 : 0;
    if (component.name === 'services') writeServiceWorkflowLauncher(output, packagePath, packageName, target, component.categoryIndex);
    if (component.name === 'simulators') writeSimulatorWorkflowDriver(output, packagePath, packageName, target, component.categoryIndex);
    for (let index = 0; index < mainCount - specialized; index += 1) {
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
  }

  const testClass = `${pascal(target)}Test`;
  writeComponentTest(output, component, packagePath, packageName, target, testClass);

  let mainClass;
  if (component.binary) {
    mainClass = `${pascal(target)}Launcher`;
    writeJava(output, `${packagePath}/src/launcher/java/${packageName.replaceAll('.', '/')}/${mainClass}.java`, [
      `package ${packageName};`,
      '',
      `public final class ${mainClass} {`,
      '    private ' + mainClass + '() {}',
      '    public static void main(String[] args) {',
      ...(component.name === 'services' ? [
        `        ${pascal(target)}WorkflowLauncher.launchDefault("service-${id}");`,
      ] : component.name === 'simulators' ? [
        `        ${pascal(target)}WorkflowDriver.driveDefault("simulation-${id}");`,
      ] : [`        System.out.println("${component.name}:${id}");`]),
      '    }',
      '}',
    ]);
  }

  const tags = component.name === 'simulators'
    ? ['qa', 'simulator']
    : component.name === 'workflows' ? ['production', 'workflow'] : ['production', singular(component.name)];
  const workflowDependency = component.name === 'services' || component.name === 'simulators'
    ? componentLabelByCategory('workflows', component.categoryIndex % 60)
    : undefined;
  const dependencyLabels = [...new Set([
    `//build-platforms/dependencies:${component.platform}`,
    ...((component.name === 'services' || component.name === 'simulators')
      ? ['//build-platforms/dependencies:workflow_bundle'] : []),
    ...(previousLabel ? [previousLabel] : []),
    ...(workflowDependency ? [workflowDependency] : []),
  ])];
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
    ...dependencyLabels.map((label) => `        "${label}",`),
    '    ],',
    `    tags = ${starlarkList(tags)},`,
    ')',
    '',
  ].join('\n'));
}

function writeTemporalSdk(output) {
  const annotations = [
    ['workflow', 'WorkflowInterface', 'TYPE'],
    ['workflow', 'WorkflowMethod', 'METHOD'],
    ['workflow', 'SignalMethod', 'METHOD'],
    ['workflow', 'QueryMethod', 'METHOD'],
    ['workflow', 'UpdateMethod', 'METHOD'],
    ['activity', 'ActivityInterface', 'TYPE'],
    ['activity', 'ActivityMethod', 'METHOD'],
  ];
  for (const [namespace, name, target] of annotations) {
    writeJava(output, `build-platforms/dependencies/src/main/java/io/temporal/${namespace}/${name}.java`, [
      `package io.temporal.${namespace};`,
      '',
      'import java.lang.annotation.ElementType;',
      'import java.lang.annotation.Retention;',
      'import java.lang.annotation.RetentionPolicy;',
      'import java.lang.annotation.Target;',
      '',
      '@Retention(RetentionPolicy.RUNTIME)',
      `@Target(ElementType.${target})`,
      `public @interface ${name} {}`,
    ]);
  }
  writeJava(output, 'build-platforms/dependencies/src/main/java/io/temporal/workflow/Workflow.java', [
    'package io.temporal.workflow;',
    '',
    'import java.util.function.BooleanSupplier;',
    '',
    'public final class Workflow {',
    '    private Workflow() {}',
    '    public static <T> T newActivityStub(Class<T> activityType) { return null; }',
    '    public static <T> T newChildWorkflowStub(Class<T> workflowType) { return null; }',
    '    public static void await(BooleanSupplier condition) {}',
    '    public static void sleep(long milliseconds) {}',
    '}',
  ]);
  writeJava(output, 'build-platforms/dependencies/src/main/java/io/temporal/client/WorkflowOptions.java', [
    'package io.temporal.client;',
    '',
    'public final class WorkflowOptions {',
    '    public static Builder newBuilder() { return new Builder(); }',
    '    public static final class Builder {',
    '        public Builder setTaskQueue(String taskQueue) { return this; }',
    '        public Builder setWorkflowId(String workflowId) { return this; }',
    '        public WorkflowOptions build() { return new WorkflowOptions(); }',
    '    }',
    '}',
  ]);
  writeJava(output, 'build-platforms/dependencies/src/main/java/io/temporal/client/WorkflowClient.java', [
    'package io.temporal.client;',
    '',
    'import java.util.concurrent.Callable;',
    '',
    'public final class WorkflowClient {',
    '    public <T> T newWorkflowStub(Class<T> workflowType, WorkflowOptions options) { return null; }',
    '    public static <R> void start(Callable<R> invocation) {}',
    '}',
  ]);
  writeJava(output, 'build-platforms/dependencies/src/main/java/io/temporal/worker/Worker.java', [
    'package io.temporal.worker;',
    '',
    'public final class Worker {',
    '    public void registerWorkflowImplementationTypes(Class<?>... workflowTypes) {}',
    '    public void registerActivitiesImplementations(Object... activities) {}',
    '}',
  ]);
  writeJava(output, 'build-platforms/dependencies/src/main/java/io/temporal/worker/WorkerFactory.java', [
    'package io.temporal.worker;',
    '',
    'import io.temporal.client.WorkflowClient;',
    '',
    'public final class WorkerFactory {',
    '    public static WorkerFactory newInstance(WorkflowClient client) { return new WorkerFactory(); }',
    '    public Worker newWorker(String taskQueue) { return new Worker(); }',
    '    public void start() {}',
    '}',
  ]);
}

function writeWorkflowSources(output, packagePath, packageName, target, id, mainCount) {
  const base = pascal(target);
  const sourceRoot = `${packagePath}/src/main/java/${packageName.replaceAll('.', '/')}`;
  writeJava(output, `${sourceRoot}/${base}Contract.java`, [
    `package ${packageName};`, '',
    'import io.temporal.workflow.QueryMethod;',
    'import io.temporal.workflow.SignalMethod;',
    'import io.temporal.workflow.UpdateMethod;',
    'import io.temporal.workflow.WorkflowInterface;',
    'import io.temporal.workflow.WorkflowMethod;', '',
    '@WorkflowInterface',
    `public interface ${base}Contract {`,
    `    @WorkflowMethod ${base}Result execute(${base}Request request);`,
    '    @SignalMethod void cancel(String reason);',
    '    @SignalMethod void pause(String reason);',
    '    @SignalMethod void resume();',
    `    @QueryMethod ${base}State status();`,
    '    @QueryMethod String auditTrail();',
    '    @UpdateMethod void amendReference(String reference);',
    '    @UpdateMethod void adjustAmount(long amount);',
    '}',
  ]);
  writeJava(output, `${sourceRoot}/${base}Activities.java`, [
    `package ${packageName};`, '',
    'import io.temporal.activity.ActivityInterface;',
    'import io.temporal.activity.ActivityMethod;', '',
    '@ActivityInterface',
    `public interface ${base}Activities {`,
    `    @ActivityMethod void validate(${base}Request request);`,
    `    @ActivityMethod String loadProfile(${base}Request request);`,
    `    @ActivityMethod String screenRisk(${base}Request request, String profile);`,
    `    @ActivityMethod String reserve(${base}Request request);`,
    '    @ActivityMethod String authorize(String reservationId, long amount);',
    '    @ActivityMethod String book(String reservationId);',
    '    @ActivityMethod void notifyCompletion(String reference, String bookingId);',
    '    @ActivityMethod void audit(String reference, String stage, String detail);',
    '    @ActivityMethod void reverseAuthorization(String authorizationId, String reason);',
    '    @ActivityMethod void release(String reservationId, String reason);',
    '}',
  ]);
  writeJava(output, `${sourceRoot}/${base}Impl.java`, [
    `package ${packageName};`, '',
    'import io.temporal.workflow.Workflow;', '',
    `public final class ${base}Impl implements ${base}Contract {`,
    `    private final ${base}Activities activities = Workflow.newActivityStub(${base}Activities.class);`,
    `    private ${base}State state = ${base}State.CREATED;`,
    '    private String reference;',
    '    private long amount;',
    '    private boolean cancelled;', '',
    '    private boolean paused;',
    '    private String cancellationReason = "not-cancelled";',
    '    private final StringBuilder audit = new StringBuilder();', '',
    `    @Override public ${base}Result execute(${base}Request request) {`,
    '        reference = request.reference();',
    '        amount = request.amount();',
    '        String reservationId = null;',
    '        String authorizationId = null;',
    '        try {',
    '            String profile = validateAndLoad(request);',
    '            String risk = assessRisk(request, profile);',
    '            reservationId = reserveCapacity(request, risk);',
    '            authorizationId = authorizePayment(reservationId);',
    '            String childBooking = coordinateChildIfRequired(request, risk);',
    '            String bookingId = childBooking.isBlank()',
    '                ? bookWithRetry(reservationId) : childBooking;',
    '            completeBooking(bookingId);',
    `            return new ${base}Result(reference, state, bookingId);`,
    '        } catch (RuntimeException failure) {',
    '            compensateFailure(reservationId, authorizationId, failure);',
    '            throw failure;',
    '        }',
    '    }',
    `    private String validateAndLoad(${base}Request request) {`,
    `        transition(${base}State.VALIDATING, "validate-request");`,
    '        activities.validate(request);',
    '        return loadProfileWithRetry(request);',
    '    }',
    `    private String loadProfileWithRetry(${base}Request request) {`,
    '        RuntimeException lastFailure = null;',
    '        for (int attempt = 1; attempt <= 3; attempt++) {',
    '            try {',
    '                String profile = activities.loadProfile(request);',
    '                record("profile-loaded-attempt-" + attempt);',
    '                return profile;',
    '            } catch (RuntimeException failure) {',
    '                lastFailure = failure;',
    '                waitBeforeRetry(attempt);',
    '            }',
    '        }',
    '        throw new IllegalStateException("profile unavailable", lastFailure);',
    '    }',
    `    private String assessRisk(${base}Request request, String profile) {`,
    `        transition(${base}State.SCREENING, "screen-risk");`,
    '        String risk = activities.screenRisk(request, profile);',
    '        if ("blocked".equals(risk)) throw new IllegalStateException("risk rejected");',
    '        return risk;',
    '    }',
    `    private String reserveCapacity(${base}Request request, String risk) {`,
    '        awaitActive();',
    '        checkCancellation();',
    '        String reservationId = activities.reserve(request);',
    `        transition(${base}State.RESERVED, "reserved:" + risk);`,
    '        return reservationId;',
    '    }',
    '    private String authorizePayment(String reservationId) {',
    '        checkCancellation();',
    '        String authorizationId = activities.authorize(reservationId, amount);',
    `        transition(${base}State.AUTHORIZED, "authorized");`,
    '        return authorizationId;',
    '    }',
    `    private String coordinateChildIfRequired(${base}Request request, String risk) {`,
    '        if (amount < 10_000L && !"review".equals(risk)) return "";',
    `        ${base}Contract child = Workflow.newChildWorkflowStub(${base}Contract.class);`,
    `        ${base}Result childResult = child.execute(new ${base}Request(reference + "-child", amount / 2));`,
    '        record("child:" + childResult.state());',
    '        return childResult.bookingId();',
    '    }',
    '    private String bookWithRetry(String reservationId) {',
    '        RuntimeException lastFailure = null;',
    '        for (int attempt = 1; attempt <= 3; attempt++) {',
    '            checkCancellation();',
    '            try {',
    '                String bookingId = activities.book(reservationId);',
    '                record("booked-attempt-" + attempt);',
    '                return bookingId;',
    '            } catch (RuntimeException failure) {',
    '                lastFailure = failure;',
    '                waitBeforeRetry(attempt);',
    '            }',
    '        }',
    '        throw new IllegalStateException("booking unavailable", lastFailure);',
    '    }',
    '    private void completeBooking(String bookingId) {',
    '        activities.notifyCompletion(reference, bookingId);',
    `        transition(${base}State.BOOKED, "completed:" + bookingId);`,
    '    }',
    '    private void compensateFailure(String reservationId, String authorizationId, RuntimeException failure) {',
    `        transition(${base}State.COMPENSATING, failure.getClass().getSimpleName());`,
    `        String reason = ${base}Compensation.reason(failure);`,
    '        if (authorizationId != null) activities.reverseAuthorization(authorizationId, reason);',
    '        if (reservationId != null) activities.release(reservationId, reason);',
    `        transition(cancelled ? ${base}State.CANCELLED : ${base}State.COMPENSATED, reason);`,
    '    }',
    '    private void waitBeforeRetry(int attempt) {',
    '        record("retry-" + attempt);',
    '        Workflow.sleep(attempt * 100L);',
    '    }',
    '    private void awaitActive() {',
    '        if (paused) Workflow.await(() -> !paused || cancelled);',
    '        checkCancellation();',
    '    }',
    '    private void checkCancellation() {',
    '        if (cancelled) throw new IllegalStateException(cancellationReason);',
    '    }',
    `    private void transition(${base}State next, String detail) {`,
    '        state = next;',
    '        record(next.name() + ":" + detail);',
    '        activities.audit(reference, next.name(), detail);',
    '    }',
    '    private void record(String value) {',
    '        if (!audit.isEmpty()) audit.append("|");',
    '        audit.append(value);',
    '    }',
    '    @Override public void cancel(String reason) {',
    '        cancellationReason = reason;',
    '        cancelled = true;',
    '        record("cancel:" + reason);',
    '    }',
    '    @Override public void pause(String reason) { paused = true; record("pause:" + reason); }',
    '    @Override public void resume() { paused = false; record("resume"); }',
    `    @Override public ${base}State status() { return state; }`,
    '    @Override public String auditTrail() { return audit.toString(); }',
    '    @Override public void amendReference(String value) { reference = value; record("reference-amended"); }',
    '    @Override public void adjustAmount(long value) {',
    '        if (value <= 0) throw new IllegalArgumentException("amount must be positive");',
    '        amount = value;',
    '        record("amount-adjusted");',
    '    }',
    '}',
  ]);
  writeJava(output, `${sourceRoot}/${base}ActivityImpl.java`, [
    `package ${packageName};`, '',
    `public final class ${base}ActivityImpl implements ${base}Activities {`,
    `    @Override public void validate(${base}Request request) {`,
    '        requireReference(request.reference());',
    '        requirePositiveAmount(request.amount());',
    '    }',
    `    @Override public String loadProfile(${base}Request request) {`,
    '        return profileKey(normalize(request.reference()));',
    '    }',
    `    @Override public String screenRisk(${base}Request request, String profile) {`,
    '        int score = riskScore(normalize(request.reference()), request.amount(), profile);',
    '        return score > 80 ? "blocked" : score > 50 ? "review" : "approved";',
    '    }',
    `    @Override public String reserve(${base}Request request) {`,
    `        return reservationKey("${id}", normalize(request.reference()), request.amount());`,
    '    }',
    '    @Override public String authorize(String reservationId, long amount) {',
    '        requirePositiveAmount(amount);',
    '        return authorizationKey(reservationId, amount);',
    '    }',
    '    @Override public String book(String reservationId) { return bookingKey(reservationId); }',
    '    @Override public void notifyCompletion(String reference, String bookingId) {',
    '        publish(formatNotification(normalize(reference), bookingId));',
    '    }',
    '    @Override public void audit(String reference, String stage, String detail) {',
    '        persistAudit(formatAudit(normalize(reference), stage, detail));',
    '    }',
    '    @Override public void reverseAuthorization(String authorizationId, String reason) {',
    '        persistReversal(reversalKey(authorizationId, reason));',
    '    }',
    '    @Override public void release(String reservationId, String reason) {',
    '        persistRelease(releaseKey(reservationId, reason));',
    '    }',
    '    private static String normalize(String value) { return value == null ? "" : value.trim().toLowerCase(); }',
    '    private static void requireReference(String value) {',
    '        if (normalize(value).isBlank()) throw new IllegalArgumentException("reference required");',
    '    }',
    '    private static void requirePositiveAmount(long value) {',
    '        if (value <= 0) throw new IllegalArgumentException("amount must be positive");',
    '    }',
    '    private static int riskScore(String reference, long amount, String profile) {',
    '        return Math.floorMod(reference.hashCode() + profile.hashCode() + Long.hashCode(amount), 100);',
    '    }',
    '    private static String profileKey(String reference) { return "profile:" + reference; }',
    '    private static String reservationKey(String shard, String reference, long amount) {',
    '        return "reservation:" + shard + ":" + reference + ":" + amount;',
    '    }',
    '    private static String authorizationKey(String reservationId, long amount) {',
    '        return "authorization:" + reservationId + ":" + amount;',
    '    }',
    '    private static String bookingKey(String reservationId) { return "booking:" + reservationId; }',
    '    private static String formatNotification(String reference, String bookingId) {',
    '        return "completed:" + reference + ":" + bookingId;',
    '    }',
    '    private static String formatAudit(String reference, String stage, String detail) {',
    '        return reference + ":" + stage + ":" + detail;',
    '    }',
    '    private static String reversalKey(String authorizationId, String reason) {',
    '        return "reverse:" + authorizationId + ":" + reason;',
    '    }',
    '    private static String releaseKey(String reservationId, String reason) {',
    '        return "release:" + reservationId + ":" + reason;',
    '    }',
    '    private static void publish(String event) { if (event.isBlank()) throw new IllegalStateException(); }',
    '    private static void persistAudit(String event) { if (event.isBlank()) throw new IllegalStateException(); }',
    '    private static void persistReversal(String event) { if (event.isBlank()) throw new IllegalStateException(); }',
    '    private static void persistRelease(String event) { if (event.isBlank()) throw new IllegalStateException(); }',
    '}',
  ]);
  writeJava(output, `${sourceRoot}/${base}Request.java`, [
    `package ${packageName};`, '',
    `public record ${base}Request(String reference, long amount) {}`,
  ]);
  writeJava(output, `${sourceRoot}/${base}Result.java`, [
    `package ${packageName};`, '',
    `public record ${base}Result(String reference, ${base}State state, String bookingId) {}`,
  ]);
  writeJava(output, `${sourceRoot}/${base}State.java`, [
    `package ${packageName};`, '',
    `public enum ${base}State { CREATED, VALIDATING, SCREENING, RESERVED, AUTHORIZED, BOOKED, COMPENSATING, COMPENSATED, CANCELLED }`,
  ]);
  writeJava(output, `${sourceRoot}/${base}Worker.java`, [
    `package ${packageName};`, '',
    'import io.temporal.client.WorkflowClient;',
    'import io.temporal.worker.Worker;',
    'import io.temporal.worker.WorkerFactory;', '',
    `public final class ${base}Worker {`,
    `    public static final String TASK_QUEUE = "workflow-${id}";`,
    `    private ${base}Worker() {}`,
    '    public static void register(WorkflowClient client, Object activities) {',
    '        WorkerFactory factory = WorkerFactory.newInstance(client);',
    '        Worker worker = factory.newWorker(TASK_QUEUE);',
    `        worker.registerWorkflowImplementationTypes(${base}Impl.class);`,
    '        worker.registerActivitiesImplementations(activities);',
    '        factory.start();',
    '    }',
    '}',
  ]);
  writeJava(output, `${sourceRoot}/${base}Compensation.java`, [
    `package ${packageName};`, '',
    `public final class ${base}Compensation {`,
    `    private ${base}Compensation() {}`,
    '    public static String reason(Throwable failure) { return "compensate:" + failure.getClass().getSimpleName(); }',
    '}',
  ]);
  for (let index = 9; index < mainCount; index += 1) {
    const className = `${base}Support${pad(index - 9, 2)}`;
    writeJava(output, `${sourceRoot}/${className}.java`, [
      `package ${packageName};`, '',
      `public final class ${className} { private ${className}() {} }`,
    ]);
  }
}

function writeServiceWorkflowLauncher(output, packagePath, packageName, target, index) {
  const base = pascal(target);
  const workflow = workflowIdentity(index % 60);
  writeJava(output, `${packagePath}/src/main/java/${packageName.replaceAll('.', '/')}/${base}WorkflowLauncher.java`, [
    `package ${packageName};`, '',
    'import io.temporal.client.WorkflowClient;',
    'import io.temporal.client.WorkflowOptions;',
    `import ${workflow.packageName}.${workflow.base}Contract;`,
    `import ${workflow.packageName}.${workflow.base}Request;`, '',
    `public final class ${base}WorkflowLauncher {`,
    `    private ${base}WorkflowLauncher() {}`,
    `    public static ${workflow.base}Contract launch(WorkflowClient client, String reference) {`,
    '        WorkflowOptions options = WorkflowOptions.newBuilder()',
    `            .setTaskQueue("workflow-${workflow.id}")`,
    '            .setWorkflowId("transaction-" + reference)',
    '            .build();',
    `        ${workflow.base}Contract workflow = client.newWorkflowStub(${workflow.base}Contract.class, options);`,
    `        WorkflowClient.start(() -> workflow.execute(new ${workflow.base}Request(reference, 100L)));`,
    '        return workflow;',
    '    }',
    '    public static void launchDefault(String reference) { launch(new WorkflowClient(), reference); }',
    '}',
  ]);
}

function writeSimulatorWorkflowDriver(output, packagePath, packageName, target, index) {
  const base = pascal(target);
  const workflow = workflowIdentity(index % 60);
  writeJava(output, `${packagePath}/src/main/java/${packageName.replaceAll('.', '/')}/${base}WorkflowDriver.java`, [
    `package ${packageName};`, '',
    'import io.temporal.client.WorkflowClient;',
    'import io.temporal.client.WorkflowOptions;',
    `import ${workflow.packageName}.${workflow.base}Contract;`,
    `import ${workflow.packageName}.${workflow.base}State;`, '',
    `public final class ${base}WorkflowDriver {`,
    `    private ${base}WorkflowDriver() {}`,
    `    public static ${workflow.base}State drive(WorkflowClient client, String reference) {`,
    `        ${workflow.base}Contract workflow = client.newWorkflowStub(`,
    `            ${workflow.base}Contract.class,`,
    `            WorkflowOptions.newBuilder().setTaskQueue("workflow-${workflow.id}").setWorkflowId(reference).build());`,
    '        workflow.pause("simulated maintenance");',
    '        workflow.amendReference(reference + "-amended");',
    '        workflow.adjustAmount(250L);',
    '        workflow.resume();',
    '        workflow.cancel("simulated cancellation");',
    '        workflow.auditTrail();',
    '        return workflow.status();',
    '    }',
    '    public static void driveDefault(String reference) { drive(new WorkflowClient(), reference); }',
    '}',
  ]);
}

function writeComponentTest(output, component, packagePath, packageName, target, testClass) {
  const base = pascal(target);
  const assertion = component.name === 'workflows'
    ? `if (!${base}Contract.class.isAnnotationPresent(io.temporal.workflow.WorkflowInterface.class)) throw new AssertionError("missing workflow contract");`
    : component.name === 'services'
      ? `if (${base}WorkflowLauncher.class.getDeclaredMethods().length == 0) throw new AssertionError("missing workflow launcher");`
      : component.name === 'simulators'
        ? `if (${base}WorkflowDriver.class.getDeclaredMethods().length == 0) throw new AssertionError("missing workflow driver");`
        : `if (${base}Part00.id().isEmpty()) throw new AssertionError("missing component id");`;
  writeJava(output, `${packagePath}/src/test/java/${packageName.replaceAll('.', '/')}/${testClass}.java`, [
    `package ${packageName};`, '',
    `public final class ${testClass} {`,
    '    public static void main(String[] args) {',
    `        ${assertion}`,
    '    }',
    '}',
  ]);
}

function workflowIdentity(index) {
  const id = pad(index, 4);
  const target = `workflow_${id}`;
  return {
    id,
    target,
    base: pascal(target),
    packageName: `com.example.layered.workflows.${target}`,
  };
}

function componentLabel(component) {
  const id = pad(component.categoryIndex, 4);
  const target = `${singular(component.name)}_${id}`;
  return `//components/${component.name}/${target}:${target}`;
}

function componentLabelByCategory(category, index) {
  const target = `${singular(category)}_${pad(index, 4)}`;
  return `//components/${category}/${target}:${target}`;
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
    '            deps = [":" + name],',
    '            tags = tags + ["application"],',
    '        )',
    '    java_test(',
    '        name = name + "_test",',
    '        srcs = test_srcs,',
    '        main_class = test_class,',
    '        use_testrunner = False,',
    '        deps = [":" + name] + deps,',
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
