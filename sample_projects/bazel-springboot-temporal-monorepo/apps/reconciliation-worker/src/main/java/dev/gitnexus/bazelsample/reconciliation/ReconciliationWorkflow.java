package dev.gitnexus.bazelsample.reconciliation;
import io.temporal.activity.ActivityInterface; import io.temporal.activity.ActivityMethod; import io.temporal.workflow.WorkflowInterface; import io.temporal.workflow.WorkflowMethod;
import java.math.BigDecimal; import java.util.List;
record LedgerEntry(String account, BigDecimal debit, BigDecimal credit) { BigDecimal difference() { return debit.subtract(credit); } }
record ReconciliationResult(String account, boolean balanced, BigDecimal variance) {}
@WorkflowInterface interface ReconciliationWorkflow { @WorkflowMethod(name="reconcile-account") ReconciliationResult reconcile(String account, List<LedgerEntry> entries); }
@ActivityInterface interface LedgerActivities { @ActivityMethod ReconciliationResult reconcile(String account, List<LedgerEntry> entries); }
class LedgerActivitiesImpl implements LedgerActivities { public ReconciliationResult reconcile(String account, List<LedgerEntry> entries) { BigDecimal variance=entries.stream().map(LedgerEntry::difference).reduce(BigDecimal.ZERO,BigDecimal::add); return new ReconciliationResult(account,variance.signum()==0,variance); } }
