package dev.gitnexus.bazelsample.api;

import io.temporal.client.WorkflowClient;
import io.temporal.client.WorkflowOptions;
import io.temporal.serviceclient.WorkflowServiceStubs;
import io.temporal.serviceclient.WorkflowServiceStubsOptions;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.context.annotation.Bean;

@SpringBootApplication
public class WorkflowApiApplication {
  public static void main(String[] args) {
    SpringApplication.run(WorkflowApiApplication.class, args);
  }

  @Bean
  WorkflowServiceStubs workflowServiceStubs() {
    String target = System.getenv().getOrDefault("TEMPORAL_TARGET", "127.0.0.1:7233");
    return WorkflowServiceStubs.newServiceStubs(
        WorkflowServiceStubsOptions.newBuilder().setTarget(target).build());
  }

  @Bean
  WorkflowClient workflowClient(WorkflowServiceStubs service) {
    return WorkflowClient.newInstance(service);
  }

  @Bean
  GreetingWorkflow greetingWorkflow(WorkflowClient client) {
    return client.newWorkflowStub(
        GreetingWorkflow.class,
        WorkflowOptions.newBuilder()
            .setTaskQueue("bazel-greetings")
            .setWorkflowId("greeting-" + java.util.UUID.randomUUID())
            .build());
  }
}
