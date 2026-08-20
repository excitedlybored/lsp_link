package com.temporal.demos.temporalspringbootdemo.banking.egress;

import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

@Repository
public interface AccountLedgerRepository extends JpaRepository<String, String> {

    String findByAccountId(String accountId);

    void updateBalance(String accountId, double amount);
}
