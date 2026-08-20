package com.temporal.demos.temporalspringbootdemo.patterns.payment;

import org.springframework.stereotype.Component;

@Component("paypalGateway")
public class PayPalPaymentGateway implements PaymentGateway {
    @Override
    public boolean processPayment(String transactionId, double amount) {
        System.out.println("Processing $" + amount + " via PayPal for tx " + transactionId);
        return true;
    }

    @Override
    public String getProviderName() {
        return "PAYPAL";
    }
}
