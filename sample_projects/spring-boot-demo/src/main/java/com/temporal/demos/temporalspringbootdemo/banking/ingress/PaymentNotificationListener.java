package com.temporal.demos.temporalspringbootdemo.banking.ingress;

import org.springframework.kafka.annotation.KafkaListener;
import org.springframework.stereotype.Component;
import com.temporal.demos.temporalspringbootdemo.banking.service.FundTransferService;

@Component
public class PaymentNotificationListener {

    private final FundTransferService transferService;

    public PaymentNotificationListener(FundTransferService transferService) {
        this.transferService = transferService;
    }

    @KafkaListener(topics = "banking.payments.inbound", groupId = "transfer-group")
    public void onInboundPaymentMessage(String paymentEvent) {
        transferService.handleInboundNotification(paymentEvent);
    }
}
