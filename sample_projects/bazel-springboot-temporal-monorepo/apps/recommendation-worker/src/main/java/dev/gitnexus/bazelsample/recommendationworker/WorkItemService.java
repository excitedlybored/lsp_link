package dev.gitnexus.bazelsample.recommendationworker;

import io.temporal.client.WorkflowClient;
import io.temporal.client.WorkflowOptions;
import java.time.Instant;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.kafka.annotation.KafkaListener;
import org.springframework.kafka.core.KafkaTemplate;
import org.springframework.stereotype.Component;
import org.springframework.stereotype.Service;

@Component
class DomainEventPublisher {
  private final KafkaTemplate<String, String> kafka;
  private final String topic;
  DomainEventPublisher(KafkaTemplate<String, String> kafka, @Value("${app.kafka.topic}") String topic) {
    this.kafka = kafka;
    this.topic = topic;
  }
  void publish(DomainEvent event) { kafka.send(topic, event.aggregateId(), event.toWire()); }
}

@Component
class DomainEventConsumer {
  private final WorkItemService service;
  DomainEventConsumer(WorkItemService service) { this.service = service; }
  @KafkaListener(topics = "${app.kafka.topic}", groupId = "recommendation-worker-projection")
  void consume(String payload) { service.observe(DomainEvent.fromWire(payload)); }
}

@Service
class WorkItemService {
  private final WorkItemRepository repository;
  private final DomainEventPublisher events;
  private final WorkflowClient workflows;
  private final String taskQueue;

  WorkItemService(WorkItemRepository repository, DomainEventPublisher events, WorkflowClient workflows,
      @Value("${app.temporal.task-queue}") String taskQueue) {
    this.repository = repository;
    this.events = events;
    this.workflows = workflows;
    this.taskQueue = taskQueue;
  }

  WorkItemView create(CreateWorkItemCommand command) {
    WorkItem received = WorkItem.receive(command);
    repository.save(WorkItemDocument.from(received));
    events.publish(DomainEvent.from(received));
    WorkItemWorkflow workflow = workflows.newWorkflowStub(WorkItemWorkflow.class,
        WorkflowOptions.newBuilder().setTaskQueue(taskQueue)
            .setWorkflowId("recommendation-worker-" + received.id()).build());
    WorkflowClient.start(workflow::process, received.id(), received.tenantId());
    WorkItem processing = received.transitionTo(WorkItemStatus.PROCESSING);
    repository.save(WorkItemDocument.from(processing));
    events.publish(DomainEvent.from(processing));
    return WorkItemView.from(processing);
  }

  WorkItemView find(String id) {
    return repository.findById(id).map(WorkItemDocument::toDomain).map(WorkItemView::from)
        .orElseThrow(() -> new IllegalArgumentException("Unknown work item " + id));
  }

  void observe(DomainEvent event) {
    if (!event.eventType().endsWith("COMPLETED")) return;
    repository.findById(event.aggregateId()).map(WorkItemDocument::toDomain)
        .filter(item -> item.status() != WorkItemStatus.COMPLETED)
        .map(item -> item.transitionTo(WorkItemStatus.COMPLETED))
        .map(WorkItemDocument::from).ifPresent(repository::save);
  }
}
