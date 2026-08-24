package dev.gitnexus.bazelsample.searchapi;

import io.temporal.workflow.WorkflowInterface;
import io.temporal.workflow.WorkflowMethod;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication
public class SearchApiApplication {
  public static void main(String[] args) { SpringApplication.run(SearchApiApplication.class, args); }
}

@WorkflowInterface
interface SearchApiWorkflow { @WorkflowMethod(name = "search-api-task") String execute(String request); }

class SearchApiWorkflowImpl implements SearchApiWorkflow {
  public String execute(String request) { return "search-api:" + request; }
}
