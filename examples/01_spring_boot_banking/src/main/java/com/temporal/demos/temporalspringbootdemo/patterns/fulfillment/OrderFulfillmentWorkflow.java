package com.temporal.demos.temporalspringbootdemo.patterns.fulfillment;

import io.temporal.workflow.WorkflowInterface;
import io.temporal.workflow.WorkflowMethod;

@WorkflowInterface
public interface OrderFulfillmentWorkflow {
    @WorkflowMethod
    String processOrder(String orderId, String address, int quantity);
}
