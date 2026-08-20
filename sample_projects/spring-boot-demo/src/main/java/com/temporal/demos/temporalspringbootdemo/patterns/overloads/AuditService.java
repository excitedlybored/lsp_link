package com.temporal.demos.temporalspringbootdemo.patterns.overloads;

import com.temporal.demos.temporalspringbootdemo.patterns.repository.Order;
import com.temporal.demos.temporalspringbootdemo.patterns.repository.GenericRepository;
import org.springframework.stereotype.Service;

@Service
public class AuditService {
    private final AuditLogger logger;
    private final GenericRepository<Order, String> orderRepo;

    public AuditService(AuditLogger logger, GenericRepository<Order, String> orderRepo) {
        this.logger = logger;
        this.orderRepo = orderRepo;
    }

    public void processOrderAudit(Order order) {
        // Disambiguation Test 1: Should call log(Order), NOT log(String) or log(Order, String)
        logger.log(order);

        // Disambiguation Test 2: Should call log(String)
        logger.log("Completed audit for order " + order.getOrderId());

        // Generics Test: Should resolve save(Order) via GenericRepository<Order, String>
        orderRepo.save(order);
    }
}
