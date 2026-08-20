package com.temporal.demos.temporalspringbootdemo.banking.egress;

import org.springframework.stereotype.Component;
import org.springframework.web.client.RestTemplate;

@Component
public class SwiftPaymentGatewayClient {

    private final RestTemplate restTemplate;

    public SwiftPaymentGatewayClient(RestTemplate restTemplate) {
        this.restTemplate = restTemplate;
    }

    public String dispatchIso20022Payment(String swiftPayload) {
        String endpoint = "https://api.swift.com/v2/payments/clearing";
        return restTemplate.postForObject(endpoint, swiftPayload, String.class);
    }
}
