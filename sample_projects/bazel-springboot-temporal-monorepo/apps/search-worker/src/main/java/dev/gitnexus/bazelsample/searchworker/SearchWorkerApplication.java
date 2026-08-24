package dev.gitnexus.bazelsample.searchworker;

import io.temporal.workflow.WorkflowInterface;
import io.temporal.workflow.WorkflowMethod;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication
public class SearchWorkerApplication {
  public static void main(String[] args) { SpringApplication.run(SearchWorkerApplication.class, args); }
}

@WorkflowInterface
interface SearchWorkerWorkflow { @WorkflowMethod(name = "search-worker-task") String execute(String request); }

class SearchWorkerWorkflowImpl implements SearchWorkerWorkflow {
  public String execute(String request) { return "search-worker:" + request; }
}
