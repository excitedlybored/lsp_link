# Bazel Spring Boot + Temporal monorepo

This is a **Bazel-only, multi-workspace Java monorepo fixture**. It intentionally
contains 30 independent nested Bazel modules. The original richer fixtures are
supplemented by API and worker services so large-monorepo discovery, scheduling,
classpath preparation, and failure isolation can be exercised realistically.

| Build root | Application | Purpose |
| --- | --- | --- |
| `apps/workflow-api` | Spring Boot HTTP API | Starts a Temporal greeting workflow |
| `apps/workflow-worker` | Spring Boot worker | Hosts the greeting workflow and activity |
| `apps/orders-api` | Spring Boot HTTP API | Accepts orders and starts fulfilment workflows |
| `apps/notification-worker` | Spring Boot worker | Delivers email, SMS, and push notifications |
| `apps/reporting-api` | Spring Boot HTTP API | Requests time-bounded sales reports |
| `apps/reconciliation-worker` | Spring Boot worker | Reconciles ledger entries asynchronously |

There are no Maven POMs, Gradle files, or wrapper scripts in this sample. Each
application owns a `MODULE.bazel`, `BUILD.bazel`, and `.bazelrc`. This layout is
useful for testing a repository scanner: files under each application must be
routed to the nearest nested Bazel build root, not to one repository-wide Java
workspace.

## Prerequisites

- Bazel 7.6+ (or Bazelisk)
- JDK 21+; JDK 25 is supported through `JAVA_HOME`
- A local Temporal development server:

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

`orders-api` persists an order projection to MongoDB. Its default URI is
`mongodb://127.0.0.1:27017/bazel_orders`; override it with `MONGODB_URI`.

## GKE deployment

Every application is a separate GKE workload under its own `apps/<name>/k8s`
directory. Set the Artifact Registry image coordinates (`REGION`, `PROJECT`,
and `TAG`) before applying the manifests. The root identity manifest creates
one Kubernetes service account per subrepo and maps it to a Google service
account through GKE Workload Identity.

```bash
kubectl apply -f k8s/namespace-and-identity.yaml
find apps -path '*/k8s/*.yaml' -print0 | xargs -0 -n1 kubectl apply -f
```

Create the `orders-mongodb` secret in `temporal-demo` before deploying
`orders-api`; it must contain a `uri` key. Workers use the in-cluster Temporal
frontend endpoint, while API Deployments also have a ClusterIP Service.

## Verify each Bazel root

From this directory:

```bash
for root in apps/*; do (cd "$root" && bazel build //:all); done
```

## Expected build-root discovery

The scanner should report one root for every application:

```bash
find apps -mindepth 1 -maxdepth 1 -type d | wc -l  # 30
```

Each identifier has the form `bazel:apps/<application-name>`.
