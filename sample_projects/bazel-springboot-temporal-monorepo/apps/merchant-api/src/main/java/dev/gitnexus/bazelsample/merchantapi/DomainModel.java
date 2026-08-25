package dev.gitnexus.bazelsample.merchantapi;

import java.time.Instant;
import java.util.Map;
import java.util.UUID;

enum WorkItemStatus { RECEIVED, VALIDATED, PROCESSING, COMPLETED, REJECTED }

record WorkItem(String id, String tenantId, String kind, Map<String, String> attributes,
    WorkItemStatus status, long version, Instant updatedAt) {
  static WorkItem receive(CreateWorkItemCommand command) {
    if (command.tenantId() == null || command.tenantId().isBlank()) {
      throw new IllegalArgumentException("tenantId is required");
    }
    return new WorkItem(UUID.randomUUID().toString(), command.tenantId(), command.kind(),
        Map.copyOf(command.attributes()), WorkItemStatus.RECEIVED, 1, Instant.now());
  }

  WorkItem transitionTo(WorkItemStatus next) {
    if (status == WorkItemStatus.COMPLETED || status == WorkItemStatus.REJECTED) {
      throw new IllegalStateException("Terminal work item cannot transition from " + status);
    }
    return new WorkItem(id, tenantId, kind, attributes, next, version + 1, Instant.now());
  }
}

record CreateWorkItemCommand(String tenantId, String kind, Map<String, String> attributes) {}
record WorkItemView(String id, String tenantId, String kind, String status, long version) {
  static WorkItemView from(WorkItem item) {
    return new WorkItemView(item.id(), item.tenantId(), item.kind(), item.status().name(), item.version());
  }
}
record DomainEvent(String eventId, String aggregateId, String tenantId, String eventType, Instant occurredAt) {
  static DomainEvent from(WorkItem item) {
    return new DomainEvent(UUID.randomUUID().toString(), item.id(), item.tenantId(),
        "WORK_ITEM_" + item.status().name(), Instant.now());
  }
  String toWire() { return String.join("|", eventId, aggregateId, tenantId, eventType, occurredAt.toString()); }
  static DomainEvent fromWire(String wire) {
    String[] fields = wire.split("\\|", 5);
    if (fields.length != 5) throw new IllegalArgumentException("Invalid domain event");
    return new DomainEvent(fields[0], fields[1], fields[2], fields[3], Instant.parse(fields[4]));
  }
}
