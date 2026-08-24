package dev.gitnexus.bazelsample.paymentworker;

import io.temporal.workflow.WorkflowInterface;
import io.temporal.workflow.WorkflowMethod;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication
public class PaymentWorkerApplication {
  public static void main(String[] args) { SpringApplication.run(PaymentWorkerApplication.class, args); }
}

@WorkflowInterface
interface PaymentWorkerWorkflow { @WorkflowMethod(name = "payment-worker-task") String execute(String request); }

class PaymentWorkerWorkflowImpl implements PaymentWorkerWorkflow {
  public String execute(String request) { return "payment-worker:" + request; }
}
