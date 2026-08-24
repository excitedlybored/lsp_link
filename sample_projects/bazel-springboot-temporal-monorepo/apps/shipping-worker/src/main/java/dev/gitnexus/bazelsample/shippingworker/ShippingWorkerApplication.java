package dev.gitnexus.bazelsample.shippingworker;

import io.temporal.workflow.WorkflowInterface;
import io.temporal.workflow.WorkflowMethod;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication
public class ShippingWorkerApplication {
  public static void main(String[] args) { SpringApplication.run(ShippingWorkerApplication.class, args); }
}

@WorkflowInterface
interface ShippingWorkerWorkflow { @WorkflowMethod(name = "shipping-worker-task") String execute(String request); }

class ShippingWorkerWorkflowImpl implements ShippingWorkerWorkflow {
  public String execute(String request) { return "shipping-worker:" + request; }
}
