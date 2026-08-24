package dev.gitnexus.bazelsample.identityapi;

import io.temporal.workflow.WorkflowInterface;
import io.temporal.workflow.WorkflowMethod;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication
public class IdentityApiApplication {
  public static void main(String[] args) { SpringApplication.run(IdentityApiApplication.class, args); }
}

@WorkflowInterface
interface IdentityApiWorkflow { @WorkflowMethod(name = "identity-api-task") String execute(String request); }

class IdentityApiWorkflowImpl implements IdentityApiWorkflow {
  public String execute(String request) { return "identity-api:" + request; }
}
