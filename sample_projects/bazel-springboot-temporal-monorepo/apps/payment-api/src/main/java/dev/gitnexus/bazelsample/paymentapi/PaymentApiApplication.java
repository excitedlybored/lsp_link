package dev.gitnexus.bazelsample.paymentapi;

import io.temporal.workflow.WorkflowInterface;
import io.temporal.workflow.WorkflowMethod;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication
public class PaymentApiApplication {
  public static void main(String[] args) { SpringApplication.run(PaymentApiApplication.class, args); }
}

@WorkflowInterface
interface PaymentApiWorkflow { @WorkflowMethod(name = "payment-api-task") String execute(String request); }

class PaymentApiWorkflowImpl implements PaymentApiWorkflow {
  public String execute(String request) { return "payment-api:" + request; }
}
