package dev.gitnexus.bazelsample.auditapi;

import io.temporal.workflow.WorkflowInterface;
import io.temporal.workflow.WorkflowMethod;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication
public class AuditApiApplication {
  public static void main(String[] args) { SpringApplication.run(AuditApiApplication.class, args); }
}

@WorkflowInterface
interface AuditApiWorkflow { @WorkflowMethod(name = "audit-api-task") String execute(String request); }

class AuditApiWorkflowImpl implements AuditApiWorkflow {
  public String execute(String request) { return "audit-api:" + request; }
}
