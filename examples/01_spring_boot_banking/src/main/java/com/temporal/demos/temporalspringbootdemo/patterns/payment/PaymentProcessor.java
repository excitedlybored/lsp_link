package com.temporal.demos.temporalspringbootdemo.patterns.payment;

import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.stereotype.Service;

@Service
public class PaymentProcessor {
    private final PaymentGateway primaryGateway;
    private final PaymentGateway secondaryGateway;

    public PaymentProcessor(@Qualifier("stripeGateway") PaymentGateway primaryGateway,
                            @Qualifier("paypalGateway") PaymentGateway secondaryGateway) {
        this.primaryGateway = primaryGateway;
        this.secondaryGateway = secondaryGateway;
    }

    public boolean executeCheckout(String txId, double amount) {
        boolean success = primaryGateway.processPayment(txId, amount);
        if (!success) {
            return secondaryGateway.processPayment(txId, amount);
        }
        return true;
    }
}
