package dev.gitnexus.bazelsample.worker;

public class GreetingActivitiesImpl implements GreetingActivities {
  @Override
  public String composeGreeting(String name) {
    return "Hello, " + name + " from a Bazel-built Temporal worker";
  }
}
