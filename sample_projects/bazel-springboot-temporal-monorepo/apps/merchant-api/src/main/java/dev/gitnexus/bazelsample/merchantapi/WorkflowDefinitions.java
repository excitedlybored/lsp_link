package dev.gitnexus.bazelsample.merchantapi;

import io.temporal.activity.ActivityInterface;
import io.temporal.activity.ActivityMethod;
import io.temporal.activity.ActivityOptions;
import io.temporal.workflow.Workflow;
import io.temporal.workflow.WorkflowInterface;
import io.temporal.workflow.WorkflowMethod;
import java.time.Duration;

@WorkflowInterface
interface WorkItemWorkflow {
  @WorkflowMethod(name = "merchant-api-process")
  String process(String workItemId, String tenantId);
}

@ActivityInterface
interface WorkItemActivities {
  @ActivityMethod String validate(String workItemId, String tenantId);
  @ActivityMethod String executePolicy(String validationToken);
  @ActivityMethod void recordCompletion(String workItemId, String outcome);
}

class WorkItemWorkflowImpl implements WorkItemWorkflow {
  private final WorkItemActivities activities = Workflow.newActivityStub(
      WorkItemActivities.class,
      ActivityOptions.newBuilder().setStartToCloseTimeout(Duration.ofSeconds(30)).build());

  public String process(String workItemId, String tenantId) {
    String validationToken = activities.validate(workItemId, tenantId);
    String outcome = activities.executePolicy(validationToken);
    activities.recordCompletion(workItemId, outcome);
    return outcome;
  }
}
