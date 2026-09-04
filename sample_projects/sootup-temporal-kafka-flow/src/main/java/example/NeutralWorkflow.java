package example;
import io.temporal.workflow.WorkflowInterface;
import io.temporal.workflow.WorkflowMethod;
@WorkflowInterface
public interface NeutralWorkflow {
  @WorkflowMethod void execute(String payload);
}
