package dev.gitnexus.bazelsample.customerapi;

import io.temporal.workflow.WorkflowInterface;
import io.temporal.workflow.WorkflowMethod;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication
public class CustomerApiApplication {
  public static void main(String[] args) { SpringApplication.run(CustomerApiApplication.class, args); }
}

@WorkflowInterface
interface CustomerApiWorkflow { @WorkflowMethod(name = "customer-api-task") String execute(String request); }

class CustomerApiWorkflowImpl implements CustomerApiWorkflow {
  public String execute(String request) { return "customer-api:" + request; }
}
