package com.temporal.demos.temporalspringbootdemo.patterns.payment;

import org.springframework.stereotype.Component;

@Component("stripeGateway")
public class StripePaymentGateway implements PaymentGateway {
    @Override
    public boolean processPayment(String transactionId, double amount) {
        System.out.println("Processing $" + amount + " via Stripe for tx " + transactionId);
        return true;
    }

    @Override
    public String getProviderName() {
        return "STRIPE";
    }
}
