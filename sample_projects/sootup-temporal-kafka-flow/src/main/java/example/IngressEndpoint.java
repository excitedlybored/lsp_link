package example;
import io.temporal.client.WorkflowClient;
public final class IngressEndpoint {
  public void accept(NeutralWorkflow workflow, String payload) {
    WorkflowClient.start(workflow, payload);
  }
}
