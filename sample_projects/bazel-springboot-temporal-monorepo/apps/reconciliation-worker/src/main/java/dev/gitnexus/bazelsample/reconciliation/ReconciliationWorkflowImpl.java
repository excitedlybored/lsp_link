package dev.gitnexus.bazelsample.reconciliation;
import io.temporal.activity.ActivityOptions; import io.temporal.workflow.Workflow; import java.time.Duration; import java.util.List;
public class ReconciliationWorkflowImpl implements ReconciliationWorkflow { private final LedgerActivities ledger=Workflow.newActivityStub(LedgerActivities.class,ActivityOptions.newBuilder().setStartToCloseTimeout(Duration.ofSeconds(20)).build()); public ReconciliationResult reconcile(String account,List<LedgerEntry> entries) { return ledger.reconcile(account,entries); } }
