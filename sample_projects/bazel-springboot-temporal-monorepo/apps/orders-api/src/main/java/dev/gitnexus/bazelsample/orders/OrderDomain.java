package dev.gitnexus.bazelsample.orders;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;

record OrderId(String value) {
  static OrderId create() { return new OrderId(UUID.randomUUID().toString()); }
}

enum OrderStatus { DRAFT, ACCEPTED, ALLOCATED, SHIPPED, CANCELLED }

record OrderLine(String sku, int quantity, BigDecimal unitPrice) {
  BigDecimal subtotal() { return unitPrice.multiply(BigDecimal.valueOf(quantity)); }
}

record Order(OrderId id, String customerId, List<OrderLine> lines, OrderStatus status, Instant createdAt) {
  BigDecimal total() { return lines.stream().map(OrderLine::subtotal).reduce(BigDecimal.ZERO, BigDecimal::add); }
  Order transitionTo(OrderStatus next) { return new Order(id, customerId, lines, next, createdAt); }
}

record CreateOrderRequest(String customerId, List<OrderLine> lines) {}
record OrderResponse(String id, String status, BigDecimal total) {
  static OrderResponse from(Order order) { return new OrderResponse(order.id().value(), order.status().name(), order.total()); }
}

interface OrderRepository {
  Order save(Order order);
  Order find(OrderId id);
}

class InMemoryOrderRepository implements OrderRepository {
  private final Map<String, Order> orders = new java.util.concurrent.ConcurrentHashMap<>();
  public Order save(Order order) { orders.put(order.id().value(), order); return order; }
  public Order find(OrderId id) {
    Order order = orders.get(id.value());
    if (order == null) throw new IllegalArgumentException("Unknown order " + id.value());
    return order;
  }
}
