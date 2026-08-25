package dev.gitnexus.bazelsample.analyticsworker;

import java.time.Instant;
import java.util.UUID;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.kafka.annotation.KafkaListener;
import org.springframework.kafka.core.KafkaTemplate;
import org.springframework.stereotype.Component;

record AnalyticsWorkerIntegrationEvent(String id, String aggregateId, String type, String payload, Instant occurredAt) {
  static AnalyticsWorkerIntegrationEvent create(String aggregateId, String type, String payload) {
    return new AnalyticsWorkerIntegrationEvent(UUID.randomUUID().toString(), aggregateId, type, payload, Instant.now());
  }
  String serialize() { return String.join("|", id, aggregateId, type, payload, occurredAt.toString()); }
  static AnalyticsWorkerIntegrationEvent deserialize(String value) {
    String[] fields = value.split("\\|", 5);
    if (fields.length != 5) throw new IllegalArgumentException("Invalid analytics-worker event");
    return new AnalyticsWorkerIntegrationEvent(fields[0], fields[1], fields[2], fields[3], Instant.parse(fields[4]));
  }
}

@Component
class AnalyticsWorkerKafkaEventBridge {
  private final KafkaTemplate<String, String> kafka;
  private final ApplicationEventPublisher localEvents;
  private final String topic;
  AnalyticsWorkerKafkaEventBridge(KafkaTemplate<String, String> kafka, ApplicationEventPublisher localEvents,
      @Value("${app.kafka.topic}") String topic) {
    this.kafka = kafka;
    this.localEvents = localEvents;
    this.topic = topic;
  }
  void publish(String aggregateId, String type, String payload) {
    AnalyticsWorkerIntegrationEvent event = AnalyticsWorkerIntegrationEvent.create(aggregateId, type, payload);
    kafka.send(topic, aggregateId, event.serialize());
  }
  @KafkaListener(topics = "${app.kafka.topic}", groupId = "analytics-worker-consumer")
  void consume(String payload) { localEvents.publishEvent(AnalyticsWorkerIntegrationEvent.deserialize(payload)); }
}
