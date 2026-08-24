package dev.gitnexus.bazelsample.returnsapi;

import io.temporal.workflow.WorkflowInterface;
import io.temporal.workflow.WorkflowMethod;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication
public class ReturnsApiApplication {
  public static void main(String[] args) { SpringApplication.run(ReturnsApiApplication.class, args); }
}

@WorkflowInterface
interface ReturnsApiWorkflow { @WorkflowMethod(name = "returns-api-task") String execute(String request); }

class ReturnsApiWorkflowImpl implements ReturnsApiWorkflow {
  public String execute(String request) { return "returns-api:" + request; }
}
