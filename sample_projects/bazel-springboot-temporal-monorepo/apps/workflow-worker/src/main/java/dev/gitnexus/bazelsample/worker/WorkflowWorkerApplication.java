package dev.gitnexus.bazelsample.worker;

import io.temporal.client.WorkflowClient;
import io.temporal.serviceclient.WorkflowServiceStubs;
import io.temporal.serviceclient.WorkflowServiceStubsOptions;
import io.temporal.worker.Worker;
import io.temporal.worker.WorkerFactory;
import jakarta.annotation.PreDestroy;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.context.annotation.Bean;

@SpringBootApplication
public class WorkflowWorkerApplication {
  private WorkerFactory workerFactory;

  public static void main(String[] args) {
    SpringApplication.run(WorkflowWorkerApplication.class, args);
  }

  @Bean
  WorkerFactory workerFactory() {
    String target = System.getenv().getOrDefault("TEMPORAL_TARGET", "127.0.0.1:7233");
    WorkflowServiceStubs service = WorkflowServiceStubs.newServiceStubs(
        WorkflowServiceStubsOptions.newBuilder().setTarget(target).build());
    workerFactory = WorkerFactory.newInstance(WorkflowClient.newInstance(service));
    Worker worker = workerFactory.newWorker("bazel-greetings");
    worker.registerWorkflowImplementationTypes(GreetingWorkflowImpl.class);
    worker.registerActivitiesImplementations(new GreetingActivitiesImpl());
    workerFactory.start();
    return workerFactory;
  }

  @PreDestroy
  void stopWorker() {
    if (workerFactory != null) {
      workerFactory.shutdown();
    }
  }
}
