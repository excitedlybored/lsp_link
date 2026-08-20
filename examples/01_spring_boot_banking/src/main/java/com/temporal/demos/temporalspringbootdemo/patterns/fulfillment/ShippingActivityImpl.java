package com.temporal.demos.temporalspringbootdemo.patterns.fulfillment;

import io.temporal.spring.boot.ActivityImpl;
import org.springframework.stereotype.Component;

@Component
@ActivityImpl(taskQueues = "DemoTaskQueue")
public class ShippingActivityImpl implements ShippingActivity {
    @Override
    public String shipOrder(String orderId, String address) {
        System.out.println("Shipped order " + orderId + " to " + address);
        return "TRACK-998877-" + orderId;
    }
}
