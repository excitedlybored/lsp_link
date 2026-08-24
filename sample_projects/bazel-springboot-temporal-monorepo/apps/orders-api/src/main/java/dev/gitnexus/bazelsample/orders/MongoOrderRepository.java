package dev.gitnexus.bazelsample.orders;

import java.util.List;
import org.springframework.data.mongodb.repository.MongoRepository;

public interface MongoOrderRepository extends MongoRepository<MongoOrderDocument, String> {
  List<MongoOrderDocument> findByCustomerIdOrderByCreatedAtDesc(String customerId);
}
