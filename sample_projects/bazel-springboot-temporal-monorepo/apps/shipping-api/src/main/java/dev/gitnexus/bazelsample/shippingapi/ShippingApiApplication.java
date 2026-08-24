package dev.gitnexus.bazelsample.shippingapi;

import io.temporal.workflow.WorkflowInterface;
import io.temporal.workflow.WorkflowMethod;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication
public class ShippingApiApplication {
  public static void main(String[] args) { SpringApplication.run(ShippingApiApplication.class, args); }
}

@WorkflowInterface
interface ShippingApiWorkflow { @WorkflowMethod(name = "shipping-api-task") String execute(String request); }

class ShippingApiWorkflowImpl implements ShippingApiWorkflow {
  public String execute(String request) { return "shipping-api:" + request; }
}
