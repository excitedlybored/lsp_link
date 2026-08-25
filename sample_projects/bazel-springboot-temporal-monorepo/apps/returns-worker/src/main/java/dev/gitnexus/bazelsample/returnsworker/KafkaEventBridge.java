package dev.gitnexus.bazelsample.returnsworker;

import java.time.Instant;
import java.util.UUID;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.kafka.annotation.KafkaListener;
import org.springframework.kafka.core.KafkaTemplate;
import org.springframework.stereotype.Component;

record ReturnsWorkerIntegrationEvent(String id, String aggregateId, String type, String payload, Instant occurredAt) {
  static ReturnsWorkerIntegrationEvent create(String aggregateId, String type, String payload) {
    return new ReturnsWorkerIntegrationEvent(UUID.randomUUID().toString(), aggregateId, type, payload, Instant.now());
  }
  String serialize() { return String.join("|", id, aggregateId, type, payload, occurredAt.toString()); }
  static ReturnsWorkerIntegrationEvent deserialize(String value) {
    String[] fields = value.split("\\|", 5);
    if (fields.length != 5) throw new IllegalArgumentException("Invalid returns-worker event");
    return new ReturnsWorkerIntegrationEvent(fields[0], fields[1], fields[2], fields[3], Instant.parse(fields[4]));
  }
}

@Component
class ReturnsWorkerKafkaEventBridge {
  private final KafkaTemplate<String, String> kafka;
  private final ApplicationEventPublisher localEvents;
  private final String topic;
  ReturnsWorkerKafkaEventBridge(KafkaTemplate<String, String> kafka, ApplicationEventPublisher localEvents,
      @Value("${app.kafka.topic}") String topic) {
    this.kafka = kafka;
    this.localEvents = localEvents;
    this.topic = topic;
  }
  void publish(String aggregateId, String type, String payload) {
    ReturnsWorkerIntegrationEvent event = ReturnsWorkerIntegrationEvent.create(aggregateId, type, payload);
    kafka.send(topic, aggregateId, event.serialize());
  }
  @KafkaListener(topics = "${app.kafka.topic}", groupId = "returns-worker-consumer")
  void consume(String payload) { localEvents.publishEvent(ReturnsWorkerIntegrationEvent.deserialize(payload)); }
}
