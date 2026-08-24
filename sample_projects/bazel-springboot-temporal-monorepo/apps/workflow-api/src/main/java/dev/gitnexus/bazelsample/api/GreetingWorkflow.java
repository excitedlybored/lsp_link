package dev.gitnexus.bazelsample.api;

import io.temporal.workflow.WorkflowInterface;
import io.temporal.workflow.WorkflowMethod;

/** Versioned Temporal contract shared with the worker module. */
@WorkflowInterface
public interface GreetingWorkflow {
  @WorkflowMethod(name = "bazel-greeting")
  String greet(String name);
}
