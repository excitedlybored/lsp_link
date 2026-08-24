package dev.gitnexus.bazelsample.customerworker;

import io.temporal.workflow.WorkflowInterface;
import io.temporal.workflow.WorkflowMethod;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication
public class CustomerWorkerApplication {
  public static void main(String[] args) { SpringApplication.run(CustomerWorkerApplication.class, args); }
}

@WorkflowInterface
interface CustomerWorkerWorkflow { @WorkflowMethod(name = "customer-worker-task") String execute(String request); }

class CustomerWorkerWorkflowImpl implements CustomerWorkerWorkflow {
  public String execute(String request) { return "customer-worker:" + request; }
}
