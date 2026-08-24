package dev.gitnexus.bazelsample.orders;

import io.temporal.client.WorkflowClient;
import io.temporal.client.WorkflowOptions;
import io.temporal.workflow.WorkflowInterface;
import io.temporal.workflow.WorkflowMethod;
import java.time.Instant;
import org.springframework.context.annotation.Bean;
import org.springframework.stereotype.Service;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@WorkflowInterface
interface OrderFulfilmentWorkflow { @WorkflowMethod(name = "order-fulfilment") void fulfil(String orderId); }

@Service
class OrderService {
  private final OrderRepository repository;
  private final WorkflowClient workflows;
  private final MongoOrderRepository mongoOrders;
  OrderService(OrderRepository repository, WorkflowClient workflows, MongoOrderRepository mongoOrders) { this.repository = repository; this.workflows = workflows; this.mongoOrders = mongoOrders; }
  OrderResponse create(CreateOrderRequest request) {
    Order order = repository.save(new Order(OrderId.create(), request.customerId(), request.lines(), OrderStatus.DRAFT, Instant.now()));
    OrderFulfilmentWorkflow workflow = workflows.newWorkflowStub(OrderFulfilmentWorkflow.class,
        WorkflowOptions.newBuilder().setTaskQueue("order-fulfilment").setWorkflowId("order-" + order.id().value()).build());
    WorkflowClient.start(workflow::fulfil, order.id().value());
    Order accepted = repository.save(order.transitionTo(OrderStatus.ACCEPTED));
    mongoOrders.save(MongoOrderDocument.from(accepted));
    return OrderResponse.from(accepted);
  }
  OrderResponse find(String id) { return OrderResponse.from(repository.find(new OrderId(id))); }
}

@RestController
@RequestMapping("/orders")
class OrdersController {
  private final OrderService orders;
  OrdersController(OrderService orders) { this.orders = orders; }
  @PostMapping OrderResponse create(@RequestBody CreateOrderRequest request) { return orders.create(request); }
  @PostMapping("/{id}/status") OrderResponse status(@PathVariable String id) { return orders.find(id); }
}

@org.springframework.context.annotation.Configuration
class OrdersConfiguration { @Bean OrderRepository orderRepository() { return new InMemoryOrderRepository(); } }
