package dev.gitnexus.bazelsample.accountingworker;

import io.temporal.client.WorkflowClient;
import io.temporal.serviceclient.WorkflowServiceStubs;
import io.temporal.serviceclient.WorkflowServiceStubsOptions;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.context.annotation.Bean;

@SpringBootApplication
public class AccountingWorkerApplication {
  public static void main(String[] args) {
    SpringApplication.run(AccountingWorkerApplication.class, args);
  }

  @Bean
  WorkflowClient temporalWorkflowClient() {
    String target = System.getenv().getOrDefault("TEMPORAL_TARGET", "127.0.0.1:7233");
    WorkflowServiceStubs service = WorkflowServiceStubs.newServiceStubs(
        WorkflowServiceStubsOptions.newBuilder().setTarget(target).build());
    return WorkflowClient.newInstance(service);
  }
}
