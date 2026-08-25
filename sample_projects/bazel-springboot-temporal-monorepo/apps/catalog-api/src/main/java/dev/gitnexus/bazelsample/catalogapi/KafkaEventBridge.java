package dev.gitnexus.bazelsample.catalogapi;

import java.time.Instant;
import java.util.UUID;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.kafka.annotation.KafkaListener;
import org.springframework.kafka.core.KafkaTemplate;
import org.springframework.stereotype.Component;

record CatalogApiIntegrationEvent(String id, String aggregateId, String type, String payload, Instant occurredAt) {
  static CatalogApiIntegrationEvent create(String aggregateId, String type, String payload) {
    return new CatalogApiIntegrationEvent(UUID.randomUUID().toString(), aggregateId, type, payload, Instant.now());
  }
  String serialize() { return String.join("|", id, aggregateId, type, payload, occurredAt.toString()); }
  static CatalogApiIntegrationEvent deserialize(String value) {
    String[] fields = value.split("\\|", 5);
    if (fields.length != 5) throw new IllegalArgumentException("Invalid catalog-api event");
    return new CatalogApiIntegrationEvent(fields[0], fields[1], fields[2], fields[3], Instant.parse(fields[4]));
  }
}

@Component
class CatalogApiKafkaEventBridge {
  private final KafkaTemplate<String, String> kafka;
  private final ApplicationEventPublisher localEvents;
  private final String topic;
  CatalogApiKafkaEventBridge(KafkaTemplate<String, String> kafka, ApplicationEventPublisher localEvents,
      @Value("${app.kafka.topic}") String topic) {
    this.kafka = kafka;
    this.localEvents = localEvents;
    this.topic = topic;
  }
  void publish(String aggregateId, String type, String payload) {
    CatalogApiIntegrationEvent event = CatalogApiIntegrationEvent.create(aggregateId, type, payload);
    kafka.send(topic, aggregateId, event.serialize());
  }
  @KafkaListener(topics = "${app.kafka.topic}", groupId = "catalog-api-consumer")
  void consume(String payload) { localEvents.publishEvent(CatalogApiIntegrationEvent.deserialize(payload)); }
}
