package dev.gitnexus.bazelsample.billingworker;

import io.temporal.workflow.WorkflowInterface;
import io.temporal.workflow.WorkflowMethod;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication
public class BillingWorkerApplication {
  public static void main(String[] args) { SpringApplication.run(BillingWorkerApplication.class, args); }
}

@WorkflowInterface
interface BillingWorkerWorkflow { @WorkflowMethod(name = "billing-worker-task") String execute(String request); }

class BillingWorkerWorkflowImpl implements BillingWorkerWorkflow {
  public String execute(String request) { return "billing-worker:" + request; }
}
