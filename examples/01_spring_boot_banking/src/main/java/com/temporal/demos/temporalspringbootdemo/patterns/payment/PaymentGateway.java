package com.temporal.demos.temporalspringbootdemo.patterns.payment;

public interface PaymentGateway {
    boolean processPayment(String transactionId, double amount);
    String getProviderName();
}
