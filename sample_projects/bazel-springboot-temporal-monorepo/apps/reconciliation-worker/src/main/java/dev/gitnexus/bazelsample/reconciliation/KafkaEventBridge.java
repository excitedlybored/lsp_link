package dev.gitnexus.bazelsample.reconciliation;

import java.time.Instant;
import java.util.UUID;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.kafka.annotation.KafkaListener;
import org.springframework.kafka.core.KafkaTemplate;
import org.springframework.stereotype.Component;

record ReconciliationWorkerIntegrationEvent(String id, String aggregateId, String type, String payload, Instant occurredAt) {
  static ReconciliationWorkerIntegrationEvent create(String aggregateId, String type, String payload) {
    return new ReconciliationWorkerIntegrationEvent(UUID.randomUUID().toString(), aggregateId, type, payload, Instant.now());
  }
  String serialize() { return String.join("|", id, aggregateId, type, payload, occurredAt.toString()); }
  static ReconciliationWorkerIntegrationEvent deserialize(String value) {
    String[] fields = value.split("\\|", 5);
    if (fields.length != 5) throw new IllegalArgumentException("Invalid reconciliation-worker event");
    return new ReconciliationWorkerIntegrationEvent(fields[0], fields[1], fields[2], fields[3], Instant.parse(fields[4]));
  }
}

@Component
class ReconciliationWorkerKafkaEventBridge {
  private final KafkaTemplate<String, String> kafka;
  private final ApplicationEventPublisher localEvents;
  private final String topic;
  ReconciliationWorkerKafkaEventBridge(KafkaTemplate<String, String> kafka, ApplicationEventPublisher localEvents,
      @Value("${app.kafka.topic}") String topic) {
    this.kafka = kafka;
    this.localEvents = localEvents;
    this.topic = topic;
  }
  void publish(String aggregateId, String type, String payload) {
    ReconciliationWorkerIntegrationEvent event = ReconciliationWorkerIntegrationEvent.create(aggregateId, type, payload);
    kafka.send(topic, aggregateId, event.serialize());
  }
  @KafkaListener(topics = "${app.kafka.topic}", groupId = "reconciliation-worker-consumer")
  void consume(String payload) { localEvents.publishEvent(ReconciliationWorkerIntegrationEvent.deserialize(payload)); }
}
