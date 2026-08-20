package com.temporal.demos.temporalspringbootdemo.patterns.fulfillment;

import io.temporal.spring.boot.ActivityImpl;
import org.springframework.stereotype.Component;

@Component
@ActivityImpl(taskQueues = "DemoTaskQueue")
public class InventoryActivityImpl implements InventoryActivity {
    @Override
    public boolean reserveInventory(String orderId, int quantity) {
        System.out.println("Reserved " + quantity + " items for order " + orderId);
        return true;
    }
}
