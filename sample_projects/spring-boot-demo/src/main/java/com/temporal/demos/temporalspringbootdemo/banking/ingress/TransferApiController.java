package com.temporal.demos.temporalspringbootdemo.banking.ingress;

import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestBody;
import com.temporal.demos.temporalspringbootdemo.banking.service.FundTransferService;

@RestController
@RequestMapping("/api/v1/transfers")
public class TransferApiController {

    private final FundTransferService transferService;

    public TransferApiController(FundTransferService transferService) {
        this.transferService = transferService;
    }

    @PostMapping("/initiate")
    public String initiateTransfer(@RequestBody String transferRequest) {
        return transferService.processTransfer(transferRequest);
    }

    @GetMapping("/{transferId}")
    public String getTransferStatus(@PathVariable("transferId") String transferId) {
        return transferService.getTransferRecord(transferId);
    }
}
