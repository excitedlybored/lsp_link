package dev.gitnexus.bazelsample.returnsworker;

import io.temporal.workflow.WorkflowInterface;
import io.temporal.workflow.WorkflowMethod;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication
public class ReturnsWorkerApplication {
  public static void main(String[] args) { SpringApplication.run(ReturnsWorkerApplication.class, args); }
}

@WorkflowInterface
interface ReturnsWorkerWorkflow { @WorkflowMethod(name = "returns-worker-task") String execute(String request); }

class ReturnsWorkerWorkflowImpl implements ReturnsWorkerWorkflow {
  public String execute(String request) { return "returns-worker:" + request; }
}
