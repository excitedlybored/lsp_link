package dev.gitnexus.bazelsample.orders;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.List;
import org.springframework.data.annotation.Id;
import org.springframework.data.mongodb.core.mapping.Document;

@Document("orders")
public record MongoOrderDocument(@Id String id, String customerId, List<MongoOrderLine> lines,
    String status, Instant createdAt, BigDecimal total) {
  static MongoOrderDocument from(Order order) {
    return new MongoOrderDocument(order.id().value(), order.customerId(),
        order.lines().stream().map(MongoOrderLine::from).toList(), order.status().name(),
        order.createdAt(), order.total());
  }
}

record MongoOrderLine(String sku, int quantity, BigDecimal unitPrice) {
  static MongoOrderLine from(OrderLine line) { return new MongoOrderLine(line.sku(), line.quantity(), line.unitPrice()); }
}
