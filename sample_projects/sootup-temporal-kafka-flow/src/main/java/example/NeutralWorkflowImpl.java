package example;
public final class NeutralWorkflowImpl implements NeutralWorkflow {
  private final PublishingActivity activity;
  public NeutralWorkflowImpl(PublishingActivity activity) { this.activity = activity; }
  @Override public void execute(String payload) { activity.publish(payload); }
}
