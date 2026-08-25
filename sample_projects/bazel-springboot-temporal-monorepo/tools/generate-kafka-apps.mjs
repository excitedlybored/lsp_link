import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appsDirectory = path.join(repository, 'apps');
const kafkaVersion = '3.2.5';
const generatedApplications = [
  'accounting-api', 'accounting-worker',
  'authorization-api', 'authorization-worker',
  'checkout-api', 'checkout-worker',
  'compliance-api', 'compliance-worker',
  'delivery-api', 'delivery-worker',
  'device-api', 'device-worker',
  'dispute-api', 'dispute-worker',
  'document-api', 'document-worker',
  'exchange-api', 'exchange-worker',
  'feature-api', 'feature-worker',
  'gateway-api', 'gateway-worker',
  'ledger-api', 'ledger-worker',
  'marketing-api', 'marketing-worker',
  'merchant-api', 'merchant-worker',
  'recommendation-api', 'recommendation-worker',
];
const newApplications = [
  'accounting-api', 'accounting-worker',
  'checkout-api', 'checkout-worker',
  'device-api', 'device-worker',
  'merchant-api', 'merchant-worker',
  'recommendation-api', 'recommendation-worker',
];

for (const applicationName of generatedApplications.filter((name) => !newApplications.includes(name))) {
  fs.rmSync(path.join(appsDirectory, applicationName), { recursive: true, force: true });
}
for (const applicationName of listExistingApplications().filter((name) => !newApplications.includes(name))) {
  addKafkaBridge(applicationName);
}
newApplications.forEach((applicationName, index) => generateApplication(applicationName, 8100 + index));
writeIdentityManifest(listExistingApplications());

function generateApplication(applicationName, port) {
  const root = path.join(appsDirectory, applicationName);
  const packageSuffix = applicationName.replaceAll('-', '');
  const packageName = `dev.gitnexus.bazelsample.${packageSuffix}`;
  const typeName = pascalCase(applicationName);
  const sourceDirectory = path.join(root, 'src/main/java', ...packageName.split('.'));
  const resourcesDirectory = path.join(root, 'src/main/resources');
  const topic = `${applicationName}.events`;
  fs.mkdirSync(sourceDirectory, { recursive: true });
  fs.mkdirSync(resourcesDirectory, { recursive: true });
  fs.mkdirSync(path.join(root, 'k8s'), { recursive: true });
  fs.rmSync(path.join(sourceDirectory, 'KafkaEventBridge.java'), { force: true });

  write(path.join(root, '.bazelrc'), [
    'build --java_language_version=21',
    'build --java_runtime_version=local_jdk',
    '',
  ].join('\n'));
  write(path.join(root, 'MODULE.bazel'), moduleFile(applicationName.replaceAll('-', '_')));
  write(path.join(root, 'BUILD.bazel'), buildFile(applicationName, packageName, typeName));
  write(path.join(resourcesDirectory, 'application.properties'), propertiesFile(applicationName, port, topic));
  write(path.join(sourceDirectory, `${typeName}Application.java`), applicationFile(packageName, typeName));
  write(path.join(sourceDirectory, 'DomainModel.java'), domainFile(packageName));
  write(path.join(sourceDirectory, 'Persistence.java'), persistenceFile(packageName, applicationName));
  write(path.join(sourceDirectory, 'WorkflowDefinitions.java'), workflowFile(packageName, applicationName));
  write(path.join(sourceDirectory, 'WorkItemService.java'), serviceFile(packageName, applicationName));
  write(path.join(sourceDirectory, 'WorkItemController.java'), controllerFile(packageName));
  write(path.join(root, 'k8s/deployment.yaml'), deploymentFile(applicationName, port));
  write(path.join(root, 'k8s/service.yaml'), serviceManifest(applicationName, port));
  write(path.join(root, 'k8s/hpa.yaml'), hpaManifest(applicationName));
}

function addKafkaBridge(applicationName) {
  const root = path.join(appsDirectory, applicationName);
  const javaFiles = findFiles(path.join(root, 'src/main/java'), (name) => name.endsWith('.java'));
  if (javaFiles.length === 0) return;
  const firstSource = fs.readFileSync(javaFiles[0], 'utf8');
  const packageName = firstSource.match(/^package\s+([\w.]+);/m)?.[1];
  if (!packageName) throw new Error(`Cannot determine Java package for ${applicationName}`);
  const sourceDirectory = path.dirname(javaFiles[0]);
  write(path.join(sourceDirectory, 'KafkaEventBridge.java'), kafkaBridgeFile(packageName, applicationName));
  addMavenArtifact(path.join(root, 'MODULE.bazel'), `org.springframework.kafka:spring-kafka:${kafkaVersion}`);
  const buildFilePath = path.join(root, 'BUILD.bazel');
  const moduleSource = fs.readFileSync(path.join(root, 'MODULE.bazel'), 'utf8');
  [
    '@maven//:io_temporal_temporal_serviceclient',
    '@maven//:org_springframework_boot_spring_boot',
    '@maven//:org_springframework_boot_spring_boot_autoconfigure',
    '@maven//:org_springframework_kafka_spring_kafka',
    '@maven//:org_springframework_spring_beans',
    '@maven//:org_springframework_spring_context',
  ].forEach((dependency) => addBazelDependency(buildFilePath, dependency));
  if (moduleSource.includes('spring-boot-starter-web')) {
    addBazelDependency(buildFilePath, '@maven//:org_springframework_spring_web');
  }
  if (moduleSource.includes('spring-boot-starter-data-mongodb')) {
    addBazelDependency(buildFilePath, '@maven//:org_springframework_data_spring_data_commons');
    addBazelDependency(buildFilePath, '@maven//:org_springframework_data_spring_data_mongodb');
  }
  if (javaFiles.some((file) => fs.readFileSync(file, 'utf8').includes('jakarta.annotation.'))) {
    addBazelDependency(buildFilePath, '@maven//:jakarta_annotation_jakarta_annotation_api');
  }
  appendProperties(path.join(root, 'src/main/resources/application.properties'), [
    `spring.kafka.bootstrap-servers=\${KAFKA_BOOTSTRAP_SERVERS:kafka.temporal-demo.svc.cluster.local:9092}`,
    `app.kafka.topic=\${KAFKA_TOPIC:${applicationName}.events}`,
    'spring.kafka.consumer.auto-offset-reset=earliest',
  ]);
}

function moduleFile(moduleName) {
  return `module(name = "${moduleName}", version = "1.0.0")

bazel_dep(name = "rules_java", version = "9.2.0")
bazel_dep(name = "rules_jvm_external", version = "6.7")
maven = use_extension("@rules_jvm_external//:extensions.bzl", "maven")
maven.install(
    artifacts = [
        "io.temporal:temporal-sdk:1.26.2",
        "org.springframework.boot:spring-boot-starter:3.3.5",
        "org.springframework.boot:spring-boot-starter-data-mongodb:3.3.5",
        "org.springframework.boot:spring-boot-starter-web:3.3.5",
        "org.springframework.kafka:spring-kafka:${kafkaVersion}",
    ],
    repositories = ["https://repo1.maven.org/maven2"],
)
use_repo(maven, "maven")
`;
}

function buildFile(applicationName, packageName, typeName) {
  return `load("@rules_java//java:defs.bzl", "java_binary", "java_library")

java_library(
    name = "app_lib",
    srcs = glob(["src/main/java/**/*.java"]),
    resources = glob(["src/main/resources/**"]),
    deps = [
        "@maven//:io_temporal_temporal_sdk",
        "@maven//:io_temporal_temporal_serviceclient",
        "@maven//:org_springframework_boot_spring_boot",
        "@maven//:org_springframework_boot_spring_boot_autoconfigure",
        "@maven//:org_springframework_boot_spring_boot_starter",
        "@maven//:org_springframework_boot_spring_boot_starter_data_mongodb",
        "@maven//:org_springframework_boot_spring_boot_starter_web",
        "@maven//:org_springframework_data_spring_data_commons",
        "@maven//:org_springframework_data_spring_data_mongodb",
        "@maven//:org_springframework_kafka_spring_kafka",
        "@maven//:org_springframework_spring_beans",
        "@maven//:org_springframework_spring_context",
        "@maven//:org_springframework_spring_web",
    ],
)

java_binary(
    name = "${applicationName}",
    main_class = "${packageName}.${typeName}Application",
    runtime_deps = [":app_lib"],
)
`;
}

function propertiesFile(applicationName, port, topic) {
  return `spring.application.name=${applicationName}
server.port=${port}
spring.data.mongodb.uri=\${MONGODB_URI:mongodb://127.0.0.1:27017/${applicationName.replaceAll('-', '_')}}
spring.data.mongodb.auto-index-creation=true
spring.kafka.bootstrap-servers=\${KAFKA_BOOTSTRAP_SERVERS:kafka.temporal-demo.svc.cluster.local:9092}
spring.kafka.consumer.auto-offset-reset=earliest
app.kafka.topic=\${KAFKA_TOPIC:${topic}}
app.temporal.task-queue=\${TEMPORAL_TASK_QUEUE:${applicationName}}
`;
}

function applicationFile(packageName, typeName) {
  return `package ${packageName};

import io.temporal.client.WorkflowClient;
import io.temporal.serviceclient.WorkflowServiceStubs;
import io.temporal.serviceclient.WorkflowServiceStubsOptions;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.context.annotation.Bean;

@SpringBootApplication
public class ${typeName}Application {
  public static void main(String[] args) {
    SpringApplication.run(${typeName}Application.class, args);
  }

  @Bean
  WorkflowClient temporalWorkflowClient() {
    String target = System.getenv().getOrDefault("TEMPORAL_TARGET", "127.0.0.1:7233");
    WorkflowServiceStubs service = WorkflowServiceStubs.newServiceStubs(
        WorkflowServiceStubsOptions.newBuilder().setTarget(target).build());
    return WorkflowClient.newInstance(service);
  }
}
`;
}

function domainFile(packageName) {
  return `package ${packageName};

import java.time.Instant;
import java.util.Map;
import java.util.UUID;

enum WorkItemStatus { RECEIVED, VALIDATED, PROCESSING, COMPLETED, REJECTED }

record WorkItem(String id, String tenantId, String kind, Map<String, String> attributes,
    WorkItemStatus status, long version, Instant updatedAt) {
  static WorkItem receive(CreateWorkItemCommand command) {
    if (command.tenantId() == null || command.tenantId().isBlank()) {
      throw new IllegalArgumentException("tenantId is required");
    }
    return new WorkItem(UUID.randomUUID().toString(), command.tenantId(), command.kind(),
        Map.copyOf(command.attributes()), WorkItemStatus.RECEIVED, 1, Instant.now());
  }

  WorkItem transitionTo(WorkItemStatus next) {
    if (status == WorkItemStatus.COMPLETED || status == WorkItemStatus.REJECTED) {
      throw new IllegalStateException("Terminal work item cannot transition from " + status);
    }
    return new WorkItem(id, tenantId, kind, attributes, next, version + 1, Instant.now());
  }
}

record CreateWorkItemCommand(String tenantId, String kind, Map<String, String> attributes) {}
record WorkItemView(String id, String tenantId, String kind, String status, long version) {
  static WorkItemView from(WorkItem item) {
    return new WorkItemView(item.id(), item.tenantId(), item.kind(), item.status().name(), item.version());
  }
}
record DomainEvent(String eventId, String aggregateId, String tenantId, String eventType, Instant occurredAt) {
  static DomainEvent from(WorkItem item) {
    return new DomainEvent(UUID.randomUUID().toString(), item.id(), item.tenantId(),
        "WORK_ITEM_" + item.status().name(), Instant.now());
  }
  String toWire() { return String.join("|", eventId, aggregateId, tenantId, eventType, occurredAt.toString()); }
  static DomainEvent fromWire(String wire) {
    String[] fields = wire.split("\\\\|", 5);
    if (fields.length != 5) throw new IllegalArgumentException("Invalid domain event");
    return new DomainEvent(fields[0], fields[1], fields[2], fields[3], Instant.parse(fields[4]));
  }
}
`;
}

function persistenceFile(packageName, applicationName) {
  return `package ${packageName};

import java.time.Instant;
import java.util.Map;
import org.springframework.data.annotation.Id;
import org.springframework.data.mongodb.core.mapping.Document;
import org.springframework.data.mongodb.repository.MongoRepository;

@Document("${applicationName.replaceAll('-', '_')}_work_items")
record WorkItemDocument(@Id String id, String tenantId, String kind, Map<String, String> attributes,
    String status, long version, Instant updatedAt) {
  static WorkItemDocument from(WorkItem item) {
    return new WorkItemDocument(item.id(), item.tenantId(), item.kind(), item.attributes(),
        item.status().name(), item.version(), item.updatedAt());
  }
  WorkItem toDomain() {
    return new WorkItem(id, tenantId, kind, attributes, WorkItemStatus.valueOf(status), version, updatedAt);
  }
}

interface WorkItemRepository extends MongoRepository<WorkItemDocument, String> {}
`;
}

function workflowFile(packageName, applicationName) {
  return `package ${packageName};

import io.temporal.activity.ActivityInterface;
import io.temporal.activity.ActivityMethod;
import io.temporal.activity.ActivityOptions;
import io.temporal.workflow.Workflow;
import io.temporal.workflow.WorkflowInterface;
import io.temporal.workflow.WorkflowMethod;
import java.time.Duration;

@WorkflowInterface
interface WorkItemWorkflow {
  @WorkflowMethod(name = "${applicationName}-process")
  String process(String workItemId, String tenantId);
}

@ActivityInterface
interface WorkItemActivities {
  @ActivityMethod String validate(String workItemId, String tenantId);
  @ActivityMethod String executePolicy(String validationToken);
  @ActivityMethod void recordCompletion(String workItemId, String outcome);
}

class WorkItemWorkflowImpl implements WorkItemWorkflow {
  private final WorkItemActivities activities = Workflow.newActivityStub(
      WorkItemActivities.class,
      ActivityOptions.newBuilder().setStartToCloseTimeout(Duration.ofSeconds(30)).build());

  public String process(String workItemId, String tenantId) {
    String validationToken = activities.validate(workItemId, tenantId);
    String outcome = activities.executePolicy(validationToken);
    activities.recordCompletion(workItemId, outcome);
    return outcome;
  }
}
`;
}

function serviceFile(packageName, applicationName) {
  return `package ${packageName};

import io.temporal.client.WorkflowClient;
import io.temporal.client.WorkflowOptions;
import java.time.Instant;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.kafka.annotation.KafkaListener;
import org.springframework.kafka.core.KafkaTemplate;
import org.springframework.stereotype.Component;
import org.springframework.stereotype.Service;

@Component
class DomainEventPublisher {
  private final KafkaTemplate<String, String> kafka;
  private final String topic;
  DomainEventPublisher(KafkaTemplate<String, String> kafka, @Value("\${app.kafka.topic}") String topic) {
    this.kafka = kafka;
    this.topic = topic;
  }
  void publish(DomainEvent event) { kafka.send(topic, event.aggregateId(), event.toWire()); }
}

@Component
class DomainEventConsumer {
  private final WorkItemService service;
  DomainEventConsumer(WorkItemService service) { this.service = service; }
  @KafkaListener(topics = "\${app.kafka.topic}", groupId = "${applicationName}-projection")
  void consume(String payload) { service.observe(DomainEvent.fromWire(payload)); }
}

@Service
class WorkItemService {
  private final WorkItemRepository repository;
  private final DomainEventPublisher events;
  private final WorkflowClient workflows;
  private final String taskQueue;

  WorkItemService(WorkItemRepository repository, DomainEventPublisher events, WorkflowClient workflows,
      @Value("\${app.temporal.task-queue}") String taskQueue) {
    this.repository = repository;
    this.events = events;
    this.workflows = workflows;
    this.taskQueue = taskQueue;
  }

  WorkItemView create(CreateWorkItemCommand command) {
    WorkItem received = WorkItem.receive(command);
    repository.save(WorkItemDocument.from(received));
    events.publish(DomainEvent.from(received));
    WorkItemWorkflow workflow = workflows.newWorkflowStub(WorkItemWorkflow.class,
        WorkflowOptions.newBuilder().setTaskQueue(taskQueue)
            .setWorkflowId("${applicationName}-" + received.id()).build());
    WorkflowClient.start(workflow::process, received.id(), received.tenantId());
    WorkItem processing = received.transitionTo(WorkItemStatus.PROCESSING);
    repository.save(WorkItemDocument.from(processing));
    events.publish(DomainEvent.from(processing));
    return WorkItemView.from(processing);
  }

  WorkItemView find(String id) {
    return repository.findById(id).map(WorkItemDocument::toDomain).map(WorkItemView::from)
        .orElseThrow(() -> new IllegalArgumentException("Unknown work item " + id));
  }

  void observe(DomainEvent event) {
    if (!event.eventType().endsWith("COMPLETED")) return;
    repository.findById(event.aggregateId()).map(WorkItemDocument::toDomain)
        .filter(item -> item.status() != WorkItemStatus.COMPLETED)
        .map(item -> item.transitionTo(WorkItemStatus.COMPLETED))
        .map(WorkItemDocument::from).ifPresent(repository::save);
  }
}
`;
}

function controllerFile(packageName) {
  return `package ${packageName};

import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/work-items")
class WorkItemController {
  private final WorkItemService service;
  WorkItemController(WorkItemService service) { this.service = service; }
  @PostMapping ResponseEntity<WorkItemView> create(@RequestBody CreateWorkItemCommand command) {
    return ResponseEntity.accepted().body(service.create(command));
  }
  @GetMapping("/{id}") WorkItemView find(@PathVariable String id) { return service.find(id); }
}
`;
}

function kafkaBridgeFile(packageName, applicationName) {
  const typeName = pascalCase(applicationName);
  return `package ${packageName};

import java.time.Instant;
import java.util.UUID;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.kafka.annotation.KafkaListener;
import org.springframework.kafka.core.KafkaTemplate;
import org.springframework.stereotype.Component;

record ${typeName}IntegrationEvent(String id, String aggregateId, String type, String payload, Instant occurredAt) {
  static ${typeName}IntegrationEvent create(String aggregateId, String type, String payload) {
    return new ${typeName}IntegrationEvent(UUID.randomUUID().toString(), aggregateId, type, payload, Instant.now());
  }
  String serialize() { return String.join("|", id, aggregateId, type, payload, occurredAt.toString()); }
  static ${typeName}IntegrationEvent deserialize(String value) {
    String[] fields = value.split("\\\\|", 5);
    if (fields.length != 5) throw new IllegalArgumentException("Invalid ${applicationName} event");
    return new ${typeName}IntegrationEvent(fields[0], fields[1], fields[2], fields[3], Instant.parse(fields[4]));
  }
}

@Component
class ${typeName}KafkaEventBridge {
  private final KafkaTemplate<String, String> kafka;
  private final ApplicationEventPublisher localEvents;
  private final String topic;
  ${typeName}KafkaEventBridge(KafkaTemplate<String, String> kafka, ApplicationEventPublisher localEvents,
      @Value("\${app.kafka.topic}") String topic) {
    this.kafka = kafka;
    this.localEvents = localEvents;
    this.topic = topic;
  }
  void publish(String aggregateId, String type, String payload) {
    ${typeName}IntegrationEvent event = ${typeName}IntegrationEvent.create(aggregateId, type, payload);
    kafka.send(topic, aggregateId, event.serialize());
  }
  @KafkaListener(topics = "\${app.kafka.topic}", groupId = "${applicationName}-consumer")
  void consume(String payload) { localEvents.publishEvent(${typeName}IntegrationEvent.deserialize(payload)); }
}
`;
}

function deploymentFile(applicationName, port) {
  return `apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${applicationName}
  namespace: temporal-demo
spec:
  replicas: 2
  selector: {matchLabels: {app: ${applicationName}}}
  template:
    metadata: {labels: {app: ${applicationName}}}
    spec:
      serviceAccountName: ${applicationName}
      containers:
        - name: app
          image: REGION-docker.pkg.dev/PROJECT/temporal-demo/${applicationName}:TAG
          ports: [{containerPort: ${port}}]
          resources:
            requests: {cpu: 250m, memory: 384Mi}
            limits: {cpu: "1", memory: 768Mi}
          readinessProbe: {tcpSocket: {port: ${port}}, initialDelaySeconds: 15, periodSeconds: 10}
          env:
            - {name: TEMPORAL_TARGET, value: "temporal-frontend.temporal.svc.cluster.local:7233"}
            - {name: KAFKA_BOOTSTRAP_SERVERS, value: "kafka.temporal-demo.svc.cluster.local:9092"}
            - name: MONGODB_URI
              valueFrom: {secretKeyRef: {name: shared-mongodb, key: uri}}
`;
}

function serviceManifest(applicationName, port) {
  return `apiVersion: v1
kind: Service
metadata: {name: ${applicationName}, namespace: temporal-demo}
spec:
  selector: {app: ${applicationName}}
  ports: [{name: http, port: 80, targetPort: ${port}}]
`;
}

function hpaManifest(applicationName) {
  return `apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata: {name: ${applicationName}, namespace: temporal-demo}
spec:
  scaleTargetRef: {apiVersion: apps/v1, kind: Deployment, name: ${applicationName}}
  minReplicas: 2
  maxReplicas: 8
  metrics:
    - type: Resource
      resource:
        name: cpu
        target: {type: Utilization, averageUtilization: 70}
`;
}

function writeIdentityManifest(applicationNames) {
  const documents = [
    'apiVersion: v1\nkind: Namespace\nmetadata: {name: temporal-demo}\n',
    ...applicationNames.sort().map((name) => `apiVersion: v1
kind: ServiceAccount
metadata:
  name: ${name}
  namespace: temporal-demo
  annotations: {iam.gke.io/gcp-service-account: ${name}@PROJECT.iam.gserviceaccount.com}
`),
  ];
  write(path.join(repository, 'k8s/namespace-and-identity.yaml'), documents.join('---\n'));
}

function addMavenArtifact(filePath, coordinate) {
  let source = fs.readFileSync(filePath, 'utf8');
  if (source.includes(coordinate)) return;
  source = source.replace(/artifacts\s*=\s*\[/, (match) => `${match}\n        "${coordinate}",`);
  write(filePath, source);
}

function addBazelDependency(filePath, dependency) {
  let source = fs.readFileSync(filePath, 'utf8');
  if (source.includes(`"${dependency}"`)) return;
  source = source.replace(/deps\s*=\s*\[/, (match) => `${match}\n        "${dependency}",`);
  write(filePath, source);
}

function appendProperties(filePath, properties) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  let source = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8').trimEnd() : '';
  for (const property of properties) {
    const key = property.slice(0, property.indexOf('='));
    if (!source.split('\n').some((line) => line.startsWith(`${key}=`))) source += `\n${property}`;
  }
  write(filePath, `${source.trimStart()}\n`);
}

function listExistingApplications() {
  return fs.readdirSync(appsDirectory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

function findFiles(directory, predicate) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    return entry.isDirectory() ? findFiles(entryPath, predicate) : predicate(entry.name) ? [entryPath] : [];
  });
}

function pascalCase(value) {
  return value.split('-').map((part) => part[0].toUpperCase() + part.slice(1)).join('');
}

function write(filePath, contents) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents);
}
