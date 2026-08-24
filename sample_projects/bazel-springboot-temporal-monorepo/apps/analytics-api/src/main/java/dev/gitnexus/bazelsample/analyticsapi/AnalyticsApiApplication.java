package dev.gitnexus.bazelsample.analyticsapi;

import io.temporal.workflow.WorkflowInterface;
import io.temporal.workflow.WorkflowMethod;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication
public class AnalyticsApiApplication {
  public static void main(String[] args) { SpringApplication.run(AnalyticsApiApplication.class, args); }
}

@WorkflowInterface
interface AnalyticsApiWorkflow { @WorkflowMethod(name = "analytics-api-task") String execute(String request); }

class AnalyticsApiWorkflowImpl implements AnalyticsApiWorkflow {
  public String execute(String request) { return "analytics-api:" + request; }
}
