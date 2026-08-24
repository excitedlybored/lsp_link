package dev.gitnexus.bazelsample.auditworker;

import io.temporal.workflow.WorkflowInterface;
import io.temporal.workflow.WorkflowMethod;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication
public class AuditWorkerApplication {
  public static void main(String[] args) { SpringApplication.run(AuditWorkerApplication.class, args); }
}

@WorkflowInterface
interface AuditWorkerWorkflow { @WorkflowMethod(name = "audit-worker-task") String execute(String request); }

class AuditWorkerWorkflowImpl implements AuditWorkerWorkflow {
  public String execute(String request) { return "audit-worker:" + request; }
}
