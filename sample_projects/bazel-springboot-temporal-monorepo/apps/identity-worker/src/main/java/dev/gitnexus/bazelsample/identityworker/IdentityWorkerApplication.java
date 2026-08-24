package dev.gitnexus.bazelsample.identityworker;

import io.temporal.workflow.WorkflowInterface;
import io.temporal.workflow.WorkflowMethod;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication
public class IdentityWorkerApplication {
  public static void main(String[] args) { SpringApplication.run(IdentityWorkerApplication.class, args); }
}

@WorkflowInterface
interface IdentityWorkerWorkflow { @WorkflowMethod(name = "identity-worker-task") String execute(String request); }

class IdentityWorkerWorkflowImpl implements IdentityWorkerWorkflow {
  public String execute(String request) { return "identity-worker:" + request; }
}
