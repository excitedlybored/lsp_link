package example;
import org.springframework.kafka.annotation.KafkaListener;
public final class TopicListener {
  @KafkaListener(topics = "${messaging.topic}", groupId = "neutral-workers")
  public void receive(String payload) {}
}
