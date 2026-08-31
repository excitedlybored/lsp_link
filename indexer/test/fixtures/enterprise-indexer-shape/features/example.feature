Feature: Example registration
  Scenario: Register an example workflow
    Given a configured workflow class
    When the worker starts
    Then the workflow is registered
