package com.temporal.demos.temporalspringbootdemo.patterns.fulfillment;

import io.temporal.activity.ActivityInterface;
import io.temporal.activity.ActivityMethod;

@ActivityInterface
public interface ShippingActivity {
    @ActivityMethod
    String shipOrder(String orderId, String address);
}
