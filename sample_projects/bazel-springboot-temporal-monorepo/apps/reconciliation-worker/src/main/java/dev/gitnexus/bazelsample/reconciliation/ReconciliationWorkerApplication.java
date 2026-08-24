package dev.gitnexus.bazelsample.reconciliation;
import io.temporal.client.WorkflowClient; import io.temporal.serviceclient.WorkflowServiceStubs; import io.temporal.worker.Worker; import io.temporal.worker.WorkerFactory;
import org.springframework.boot.SpringApplication; import org.springframework.boot.autoconfigure.SpringBootApplication; import org.springframework.context.annotation.Bean;
@SpringBootApplication public class ReconciliationWorkerApplication {
 public static void main(String[] args) { SpringApplication.run(ReconciliationWorkerApplication.class, args); }
 @Bean WorkerFactory workers() { WorkerFactory f = WorkerFactory.newInstance(WorkflowClient.newInstance(WorkflowServiceStubs.newLocalServiceStubs())); Worker w=f.newWorker("reconciliation"); w.registerWorkflowImplementationTypes(ReconciliationWorkflowImpl.class); w.registerActivitiesImplementations(new LedgerActivitiesImpl()); f.start(); return f; }
}
