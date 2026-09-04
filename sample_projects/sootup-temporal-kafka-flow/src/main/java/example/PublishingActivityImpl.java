package example;
import org.springframework.kafka.core.KafkaTemplate;
public final class PublishingActivityImpl implements PublishingActivity {
  private final KafkaTemplate<String, String> template;
  private final String topic;
  public PublishingActivityImpl(KafkaTemplate<String, String> template, String topic) {
    this.template = template;
    this.topic = topic;
  }
  @Override public void publish(String payload) { template.send(topic, payload); }
}
