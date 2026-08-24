package dev.gitnexus.bazelsample.inventoryworker;

import io.temporal.workflow.WorkflowInterface;
import io.temporal.workflow.WorkflowMethod;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication
public class InventoryWorkerApplication {
  public static void main(String[] args) { SpringApplication.run(InventoryWorkerApplication.class, args); }
}

@WorkflowInterface
interface InventoryWorkerWorkflow { @WorkflowMethod(name = "inventory-worker-task") String execute(String request); }

class InventoryWorkerWorkflowImpl implements InventoryWorkerWorkflow {
  public String execute(String request) { return "inventory-worker:" + request; }
}
