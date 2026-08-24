package dev.gitnexus.bazelsample.fraudapi;

import io.temporal.workflow.WorkflowInterface;
import io.temporal.workflow.WorkflowMethod;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication
public class FraudApiApplication {
  public static void main(String[] args) { SpringApplication.run(FraudApiApplication.class, args); }
}

@WorkflowInterface
interface FraudApiWorkflow { @WorkflowMethod(name = "fraud-api-task") String execute(String request); }

class FraudApiWorkflowImpl implements FraudApiWorkflow {
  public String execute(String request) { return "fraud-api:" + request; }
}
