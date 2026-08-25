import { LedgerDatabase } from '../egress/ledger_db';
import { SwiftHttpClient } from '../egress/swift_http_client';

export class PaymentService {
  private ledgerDb: LedgerDatabase;
  private swiftClient: SwiftHttpClient;

  constructor() {
    this.ledgerDb = new LedgerDatabase();
    this.swiftClient = new SwiftHttpClient();
  }

  async sendPayment(paymentData: { id: string; amount: number; currency: string }) {
    // 1. Egress: Save ledger record to Database
    await this.ledgerDb.saveLedgerEntry(paymentData.id, paymentData.amount, paymentData.currency);

    // 2. Egress: Dispatch external SWIFT payment via HTTP
    await this.swiftClient.dispatchIso20022Payment(paymentData);

    return paymentData.id;
  }

  async getPayment(id: string) {
    return this.ledgerDb.findPayment(id);
  }
}
