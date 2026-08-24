package dev.gitnexus.bazelsample.pricingapi;

import io.temporal.workflow.WorkflowInterface;
import io.temporal.workflow.WorkflowMethod;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication
public class PricingApiApplication {
  public static void main(String[] args) { SpringApplication.run(PricingApiApplication.class, args); }
}

@WorkflowInterface
interface PricingApiWorkflow { @WorkflowMethod(name = "pricing-api-task") String execute(String request); }

class PricingApiWorkflowImpl implements PricingApiWorkflow {
  public String execute(String request) { return "pricing-api:" + request; }
}
