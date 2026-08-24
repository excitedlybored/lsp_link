package dev.gitnexus.bazelsample.catalogapi;

import io.temporal.workflow.WorkflowInterface;
import io.temporal.workflow.WorkflowMethod;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication
public class CatalogApiApplication {
  public static void main(String[] args) { SpringApplication.run(CatalogApiApplication.class, args); }
}

@WorkflowInterface
interface CatalogApiWorkflow { @WorkflowMethod(name = "catalog-api-task") String execute(String request); }

class CatalogApiWorkflowImpl implements CatalogApiWorkflow {
  public String execute(String request) { return "catalog-api:" + request; }
}
