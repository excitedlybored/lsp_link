package dev.gitnexus.bazelsample.notifications;

import io.temporal.activity.ActivityOptions;
import io.temporal.workflow.Workflow;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;

public class NotificationWorkflowImpl implements NotificationWorkflow {
  private final EmailActivities email = Workflow.newActivityStub(EmailActivities.class, options());
  private final SmsActivities sms = Workflow.newActivityStub(SmsActivities.class, options());
  private final PushActivities push = Workflow.newActivityStub(PushActivities.class, options());
  private ActivityOptions options() { return ActivityOptions.newBuilder().setStartToCloseTimeout(Duration.ofSeconds(10)).build(); }
  public List<DeliveryResult> dispatch(Notification notification) {
    List<DeliveryResult> results = new ArrayList<>();
    for (Channel channel : notification.channels()) {
      DeliveryResult result;
      switch (channel) {
        case EMAIL: result = email.deliverEmail(notification); break;
        case SMS: result = sms.deliverSms(notification); break;
        case PUSH: result = push.deliverPush(notification); break;
        default: throw new IllegalArgumentException("Unsupported notification channel " + channel);
      }
      results.add(result);
    }
    return results;
  }
}
