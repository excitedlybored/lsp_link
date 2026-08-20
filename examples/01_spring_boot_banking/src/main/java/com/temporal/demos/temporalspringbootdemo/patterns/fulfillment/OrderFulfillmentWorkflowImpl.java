package com.temporal.demos.temporalspringbootdemo.patterns.fulfillment;

import io.temporal.activity.ActivityOptions;
import io.temporal.spring.boot.WorkflowImpl;
import io.temporal.workflow.Workflow;

import java.time.Duration;

@WorkflowImpl(taskQueues = "DemoTaskQueue")
public class OrderFulfillmentWorkflowImpl implements OrderFulfillmentWorkflow {

    private final InventoryActivity inventoryActivity =
            Workflow.newActivityStub(InventoryActivity.class,
                    ActivityOptions.newBuilder()
                            .setStartToCloseTimeout(Duration.ofSeconds(5))
                            .build());

    private final ShippingActivity shippingActivity =
            Workflow.newActivityStub(ShippingActivity.class,
                    ActivityOptions.newBuilder()
                            .setStartToCloseTimeout(Duration.ofSeconds(10))
                            .build());

    @Override
    public String processOrder(String orderId, String address, int quantity) {
        // Step 1: Call Inventory Activity Stub
        boolean reserved = inventoryActivity.reserveInventory(orderId, quantity);
        if (!reserved) {
            return "FAILED_OUT_OF_STOCK";
        }

        // Step 2: Call Shipping Activity Stub
        String trackingNumber = shippingActivity.shipOrder(orderId, address);
        return "SUCCESS: " + trackingNumber;
    }
}
