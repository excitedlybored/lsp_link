package com.temporal.demos.temporalspringbootdemo.banking.service;

import org.springframework.stereotype.Service;
import com.temporal.demos.temporalspringbootdemo.banking.egress.AccountLedgerRepository;
import com.temporal.demos.temporalspringbootdemo.banking.egress.SwiftPaymentGatewayClient;
import com.temporal.demos.temporalspringbootdemo.banking.egress.AuditLogProducer;

@Service
public class FundTransferService {

    private final AccountLedgerRepository ledgerRepository;
    private final SwiftPaymentGatewayClient swiftClient;
    private final AuditLogProducer auditProducer;

    public FundTransferService(
            AccountLedgerRepository ledgerRepository,
            SwiftPaymentGatewayClient swiftClient,
            AuditLogProducer auditProducer) {
        this.ledgerRepository = ledgerRepository;
        this.swiftClient = swiftClient;
        this.auditProducer = auditProducer;
    }

    public String processTransfer(String transferRequest) {
        // 1. Egress: Persist ledger record in database
        ledgerRepository.save(transferRequest);

        // 2. Egress: Dispatch external payment via SWIFT
        String swiftResponse = swiftClient.dispatchIso20022Payment(transferRequest);

        // 3. Egress: Publish audit event to Kafka
        auditProducer.publishAuditRecord("TRANSFER_INITIATED: " + transferRequest);

        return swiftResponse;
    }

    public void handleInboundNotification(String paymentEvent) {
        // Egress: Audit inbound event
        auditProducer.publishAuditRecord("PAYMENT_NOTIFICATION_RECEIVED: " + paymentEvent);
    }

    public String getTransferRecord(String transferId) {
        return ledgerRepository.findByAccountId(transferId);
    }
}
