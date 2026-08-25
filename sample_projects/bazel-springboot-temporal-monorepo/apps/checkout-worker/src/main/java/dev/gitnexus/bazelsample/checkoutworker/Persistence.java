package dev.gitnexus.bazelsample.checkoutworker;

import java.time.Instant;
import java.util.Map;
import org.springframework.data.annotation.Id;
import org.springframework.data.mongodb.core.mapping.Document;
import org.springframework.data.mongodb.repository.MongoRepository;

@Document("checkout_worker_work_items")
record WorkItemDocument(@Id String id, String tenantId, String kind, Map<String, String> attributes,
    String status, long version, Instant updatedAt) {
  static WorkItemDocument from(WorkItem item) {
    return new WorkItemDocument(item.id(), item.tenantId(), item.kind(), item.attributes(),
        item.status().name(), item.version(), item.updatedAt());
  }
  WorkItem toDomain() {
    return new WorkItem(id, tenantId, kind, attributes, WorkItemStatus.valueOf(status), version, updatedAt);
  }
}

interface WorkItemRepository extends MongoRepository<WorkItemDocument, String> {}
