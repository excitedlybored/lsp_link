package dev.gitnexus.bazelsample.loyaltyapi;

import io.temporal.workflow.WorkflowInterface;
import io.temporal.workflow.WorkflowMethod;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication
public class LoyaltyApiApplication {
  public static void main(String[] args) { SpringApplication.run(LoyaltyApiApplication.class, args); }
}

@WorkflowInterface
interface LoyaltyApiWorkflow { @WorkflowMethod(name = "loyalty-api-task") String execute(String request); }

class LoyaltyApiWorkflowImpl implements LoyaltyApiWorkflow {
  public String execute(String request) { return "loyalty-api:" + request; }
}
