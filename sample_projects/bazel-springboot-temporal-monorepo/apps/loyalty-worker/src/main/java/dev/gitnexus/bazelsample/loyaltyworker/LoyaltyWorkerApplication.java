package dev.gitnexus.bazelsample.loyaltyworker;

import io.temporal.workflow.WorkflowInterface;
import io.temporal.workflow.WorkflowMethod;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication
public class LoyaltyWorkerApplication {
  public static void main(String[] args) { SpringApplication.run(LoyaltyWorkerApplication.class, args); }
}

@WorkflowInterface
interface LoyaltyWorkerWorkflow { @WorkflowMethod(name = "loyalty-worker-task") String execute(String request); }

class LoyaltyWorkerWorkflowImpl implements LoyaltyWorkerWorkflow {
  public String execute(String request) { return "loyalty-worker:" + request; }
}
