package com.temporal.demos.temporalspringbootdemo.patterns.repository;

public class Order {
    private String orderId;
    private double totalAmount;
    private String customerEmail;

    public Order() {}

    public Order(String orderId, double totalAmount, String customerEmail) {
        this.orderId = orderId;
        this.totalAmount = totalAmount;
        this.customerEmail = customerEmail;
    }

    public String getOrderId() {
        return orderId;
    }

    public void setOrderId(String orderId) {
        this.orderId = orderId;
    }

    public double getTotalAmount() {
        return totalAmount;
    }

    public void setTotalAmount(double totalAmount) {
        this.totalAmount = totalAmount;
    }

    public String getCustomerEmail() {
        return customerEmail;
    }

    public void setCustomerEmail(String customerEmail) {
        this.customerEmail = customerEmail;
    }
}
