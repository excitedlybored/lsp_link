package dev.gitnexus.bazelsample.analyticsworker;

import io.temporal.workflow.WorkflowInterface;
import io.temporal.workflow.WorkflowMethod;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication
public class AnalyticsWorkerApplication {
  public static void main(String[] args) { SpringApplication.run(AnalyticsWorkerApplication.class, args); }
}

@WorkflowInterface
interface AnalyticsWorkerWorkflow { @WorkflowMethod(name = "analytics-worker-task") String execute(String request); }

class AnalyticsWorkerWorkflowImpl implements AnalyticsWorkerWorkflow {
  public String execute(String request) { return "analytics-worker:" + request; }
}
