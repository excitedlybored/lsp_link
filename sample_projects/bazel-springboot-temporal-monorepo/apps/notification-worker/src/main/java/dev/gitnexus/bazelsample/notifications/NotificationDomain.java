package dev.gitnexus.bazelsample.notifications;

import io.temporal.activity.ActivityInterface;
import io.temporal.activity.ActivityMethod;
import io.temporal.workflow.WorkflowInterface;
import io.temporal.workflow.WorkflowMethod;
import java.time.Instant;
import java.util.List;

enum Channel { EMAIL, SMS, PUSH }
record Notification(String recipient, String subject, String body, List<Channel> channels, Instant requestedAt) {}
record DeliveryResult(Channel channel, boolean delivered, String providerReference) {}

@WorkflowInterface
interface NotificationWorkflow { @WorkflowMethod(name = "send-notification") List<DeliveryResult> dispatch(Notification notification); }

@ActivityInterface interface EmailActivities { @ActivityMethod DeliveryResult deliverEmail(Notification notification); }
@ActivityInterface interface SmsActivities { @ActivityMethod DeliveryResult deliverSms(Notification notification); }
@ActivityInterface interface PushActivities { @ActivityMethod DeliveryResult deliverPush(Notification notification); }

class EmailGateway implements EmailActivities { public DeliveryResult deliverEmail(Notification n) { return new DeliveryResult(Channel.EMAIL, true, "email-" + n.recipient()); } }
class SmsGateway implements SmsActivities { public DeliveryResult deliverSms(Notification n) { return new DeliveryResult(Channel.SMS, true, "sms-" + n.recipient()); } }
class PushGateway implements PushActivities { public DeliveryResult deliverPush(Notification n) { return new DeliveryResult(Channel.PUSH, true, "push-" + n.recipient()); } }
