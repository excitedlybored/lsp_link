package com.temporal.demos.temporalspringbootdemo.patterns.fulfillment;

import io.temporal.activity.ActivityInterface;
import io.temporal.activity.ActivityMethod;

@ActivityInterface
public interface InventoryActivity {
    @ActivityMethod
    boolean reserveInventory(String orderId, int quantity);
}
