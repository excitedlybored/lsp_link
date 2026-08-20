package com.temporal.demos.temporalspringbootdemo.patterns.overloads;

import com.temporal.demos.temporalspringbootdemo.patterns.repository.Order;
import org.springframework.stereotype.Component;

@Component
public class AuditLogger {

    public void log(String plainMessage) {
        System.out.println("[AUDIT STRING] " + plainMessage);
    }

    public void log(Order domainOrder) {
        System.out.println("[AUDIT ORDER] ID: " + domainOrder.getOrderId() + ", Amount: " + domainOrder.getTotalAmount());
    }

    public void log(Order domainOrder, String reason) {
        System.out.println("[AUDIT ORDER+REASON] ID: " + domainOrder.getOrderId() + " | Reason: " + reason);
    }
}
