package dev.gitnexus.bazelsample.fraudworker;

import io.temporal.workflow.WorkflowInterface;
import io.temporal.workflow.WorkflowMethod;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication
public class FraudWorkerApplication {
  public static void main(String[] args) { SpringApplication.run(FraudWorkerApplication.class, args); }
}

@WorkflowInterface
interface FraudWorkerWorkflow { @WorkflowMethod(name = "fraud-worker-task") String execute(String request); }

class FraudWorkerWorkflowImpl implements FraudWorkerWorkflow {
  public String execute(String request) { return "fraud-worker:" + request; }
}
