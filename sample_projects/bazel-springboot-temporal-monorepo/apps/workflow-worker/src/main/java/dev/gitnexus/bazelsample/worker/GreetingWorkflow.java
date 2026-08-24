package dev.gitnexus.bazelsample.worker;

import io.temporal.workflow.WorkflowInterface;
import io.temporal.workflow.WorkflowMethod;

/** Must stay wire-compatible with the API module's versioned workflow contract. */
@WorkflowInterface
public interface GreetingWorkflow {
  @WorkflowMethod(name = "bazel-greeting")
  String greet(String name);
}
