package dev.gitnexus.bazelsample.reporting;
import io.temporal.client.WorkflowClient;
import io.temporal.client.WorkflowOptions;
import io.temporal.workflow.WorkflowInterface;
import io.temporal.workflow.WorkflowMethod;
import java.math.BigDecimal;
import java.time.LocalDate;
import java.util.List;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
record ReportRequest(String tenant, LocalDate from, LocalDate to) {}
record ReportLine(String category, long count, BigDecimal amount) {}
record ReportSummary(String reportId, List<ReportLine> lines, BigDecimal total) {}
@WorkflowInterface interface ReportWorkflow { @WorkflowMethod(name = "compile-report") ReportSummary compile(ReportRequest request); }
@RestController @RequestMapping("/reports") class ReportingController {
  private final WorkflowClient client;
  ReportingController(WorkflowClient client) { this.client = client; }
  @GetMapping("/sales") ReportSummary sales(@RequestParam String tenant) {
    ReportWorkflow workflow = client.newWorkflowStub(ReportWorkflow.class, WorkflowOptions.newBuilder().setTaskQueue("reporting").build());
    return workflow.compile(new ReportRequest(tenant, LocalDate.now().minusDays(30), LocalDate.now()));
  }
}
