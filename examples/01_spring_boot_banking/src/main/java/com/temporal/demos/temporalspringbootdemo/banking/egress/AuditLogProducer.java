package com.temporal.demos.temporalspringbootdemo.banking.egress;

import org.springframework.kafka.core.KafkaTemplate;
import org.springframework.stereotype.Component;

@Component
public class AuditLogProducer {

    private final KafkaTemplate<String, String> kafkaTemplate;

    public AuditLogProducer(KafkaTemplate<String, String> kafkaTemplate) {
        this.kafkaTemplate = kafkaTemplate;
    }

    public void publishAuditRecord(String auditEvent) {
        kafkaTemplate.send("banking.audit.events", auditEvent);
    }
}
