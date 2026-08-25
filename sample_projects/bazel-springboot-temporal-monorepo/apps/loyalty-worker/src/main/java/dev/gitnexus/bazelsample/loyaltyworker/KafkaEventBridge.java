package dev.gitnexus.bazelsample.loyaltyworker;

import java.time.Instant;
import java.util.UUID;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.kafka.annotation.KafkaListener;
import org.springframework.kafka.core.KafkaTemplate;
import org.springframework.stereotype.Component;

record LoyaltyWorkerIntegrationEvent(String id, String aggregateId, String type, String payload, Instant occurredAt) {
  static LoyaltyWorkerIntegrationEvent create(String aggregateId, String type, String payload) {
    return new LoyaltyWorkerIntegrationEvent(UUID.randomUUID().toString(), aggregateId, type, payload, Instant.now());
  }
  String serialize() { return String.join("|", id, aggregateId, type, payload, occurredAt.toString()); }
  static LoyaltyWorkerIntegrationEvent deserialize(String value) {
    String[] fields = value.split("\\|", 5);
    if (fields.length != 5) throw new IllegalArgumentException("Invalid loyalty-worker event");
    return new LoyaltyWorkerIntegrationEvent(fields[0], fields[1], fields[2], fields[3], Instant.parse(fields[4]));
  }
}

@Component
class LoyaltyWorkerKafkaEventBridge {
  private final KafkaTemplate<String, String> kafka;
  private final ApplicationEventPublisher localEvents;
  private final String topic;
  LoyaltyWorkerKafkaEventBridge(KafkaTemplate<String, String> kafka, ApplicationEventPublisher localEvents,
      @Value("${app.kafka.topic}") String topic) {
    this.kafka = kafka;
    this.localEvents = localEvents;
    this.topic = topic;
  }
  void publish(String aggregateId, String type, String payload) {
    LoyaltyWorkerIntegrationEvent event = LoyaltyWorkerIntegrationEvent.create(aggregateId, type, payload);
    kafka.send(topic, aggregateId, event.serialize());
  }
  @KafkaListener(topics = "${app.kafka.topic}", groupId = "loyalty-worker-consumer")
  void consume(String payload) { localEvents.publishEvent(LoyaltyWorkerIntegrationEvent.deserialize(payload)); }
}
