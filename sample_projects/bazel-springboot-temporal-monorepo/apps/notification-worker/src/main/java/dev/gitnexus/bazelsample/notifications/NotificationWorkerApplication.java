package dev.gitnexus.bazelsample.notifications;

import io.temporal.client.WorkflowClient;
import io.temporal.serviceclient.WorkflowServiceStubs;
import io.temporal.serviceclient.WorkflowServiceStubsOptions;
import io.temporal.worker.Worker;
import io.temporal.worker.WorkerFactory;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.context.annotation.Bean;

@SpringBootApplication
public class NotificationWorkerApplication {
  public static void main(String[] args) { SpringApplication.run(NotificationWorkerApplication.class, args); }
  @Bean WorkerFactory notificationWorkers() {
    String target = System.getenv().getOrDefault("TEMPORAL_TARGET", "127.0.0.1:7233");
    WorkflowServiceStubs stubs = WorkflowServiceStubs.newServiceStubs(WorkflowServiceStubsOptions.newBuilder().setTarget(target).build());
    WorkerFactory factory = WorkerFactory.newInstance(WorkflowClient.newInstance(stubs));
    Worker worker = factory.newWorker("notifications");
    worker.registerWorkflowImplementationTypes(NotificationWorkflowImpl.class);
    worker.registerActivitiesImplementations(new EmailGateway(), new SmsGateway(), new PushGateway());
    factory.start();
    return factory;
  }
}
