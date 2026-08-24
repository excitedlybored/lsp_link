package dev.gitnexus.bazelsample.api;

import io.temporal.client.WorkflowClient;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/greetings")
public class GreetingController {
  private final GreetingWorkflow greetingWorkflow;

  GreetingController(GreetingWorkflow greetingWorkflow) {
    this.greetingWorkflow = greetingWorkflow;
  }

  @PostMapping("/{name}")
  String start(@PathVariable String name) {
    WorkflowClient.start(greetingWorkflow::greet, name);
    return "workflow started for " + name;
  }
}
