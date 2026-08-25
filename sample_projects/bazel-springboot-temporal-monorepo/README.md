# Bazel Spring Boot + Temporal + Kafka monorepo

This is a **Bazel-only, multi-workspace Java monorepo fixture**. It intentionally
contains 40 independent nested Bazel modules. Every module uses Spring Boot,
Temporal, and Spring Kafka. The 10 generated enterprise applications also use
MongoDB projections, REST controllers, multi-step Temporal workflows, Kafka
event producers and consumers, and domain state transitions. This makes
large-monorepo discovery, classpath preparation, dependency enrichment,
autowiring, and failure isolation realistic without coupling the build roots.

| Build root | Application | Purpose |
| --- | --- | --- |
| `apps/workflow-api` | Spring Boot HTTP API | Starts a Temporal greeting workflow |
| `apps/workflow-worker` | Spring Boot worker | Hosts the greeting workflow and activity |
| `apps/orders-api` | Spring Boot HTTP API | Accepts orders and starts fulfilment workflows |
| `apps/notification-worker` | Spring Boot worker | Delivers email, SMS, and push notifications |
| `apps/reporting-api` | Spring Boot HTTP API | Requests time-bounded sales reports |
| `apps/reconciliation-worker` | Spring Boot worker | Reconciles ledger entries asynchronously |
| `apps/accounting-api`, `apps/checkout-api`, `apps/device-api`, `apps/merchant-api`, `apps/recommendation-api` (and workers) | Enterprise API/worker pairs | Persist MongoDB work items, start Temporal workflows, and exchange Kafka domain events |

There are no Maven POMs, Gradle files, or wrapper scripts in this sample. Each
application owns a `MODULE.bazel`, `BUILD.bazel`, and `.bazelrc`. This layout is
useful for testing a repository scanner: files under each application must be
routed to the nearest nested Bazel build root, not to one repository-wide Java
workspace.

## Prerequisites

- Bazel 7.6+ (or Bazelisk)
- JDK 21+; JDK 25 is supported through `JAVA_HOME`
- A local Temporal development server:
- Kafka, available through `KAFKA_BOOTSTRAP_SERVERS`;
- MongoDB, available through `MONGODB_URI`.

```bash
temporal server start-dev
```

## Run the sample

In one terminal, start the worker:

```bash
cd apps/workflow-worker
bazel run //:worker
```

In another terminal, start the API:

```bash
cd apps/workflow-api
bazel run //:api
```

Start a workflow:

```bash
curl -X POST http://localhost:8080/greetings/Ada
```

Both applications use `TEMPORAL_TARGET` when it is set, otherwise they connect
to `127.0.0.1:7233`.

`orders-api` and the 10 generated enterprise applications persist projections
to MongoDB. The orders default URI is
`mongodb://127.0.0.1:27017/bazel_orders`; override it with `MONGODB_URI`.

Every application publishes and consumes a dedicated Kafka topic through
Spring Kafka. Override the in-cluster default with `KAFKA_BOOTSTRAP_SERVERS`
and override a module's topic with `KAFKA_TOPIC`.

## GKE deployment

Every application is a separate GKE workload under its own `apps/<name>/k8s`
directory. Generated applications include a Deployment, ClusterIP Service, and
HorizontalPodAutoscaler. Set the Artifact Registry image coordinates (`REGION`,
`PROJECT`, and `TAG`) before applying the manifests. The root identity manifest
creates one Kubernetes service account per subrepo and maps it to a Google
service account through GKE Workload Identity. `k8s/kafka.yaml` provides a
single-broker KRaft Kafka fixture for GKE integration tests.

```bash
kubectl apply -f k8s/namespace-and-identity.yaml
kubectl apply -f k8s/kafka.yaml
find apps -path '*/k8s/*.yaml' -print0 | xargs -0 -n1 kubectl apply -f
```

Create the `orders-mongodb` and `shared-mongodb` secrets in `temporal-demo`
before deploying; each must contain a `uri` key. Applications use the in-cluster
Temporal frontend and Kafka service endpoints.

## Verify each Bazel root

From this directory:

```bash
for root in apps/*; do (cd "$root" && bazel build //:all); done
```

Or run the bounded verifier used by this fixture (default concurrency: four):

```bash
node tools/verify-builds.mjs 4
```

## Expected build-root discovery

The scanner should report one root for every application:

```bash
find apps -mindepth 1 -maxdepth 1 -type d | wc -l  # 40
```

Each identifier has the form `bazel:apps/<application-name>`.

## Regeneration

`tools/generate-kafka-apps.mjs` deterministically maintains the generated 10
enterprise roots, Kafka bridges for the original 30 roots, and all 40 GKE
Workload Identity service accounts.
