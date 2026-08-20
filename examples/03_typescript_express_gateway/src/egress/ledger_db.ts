import { PrismaClient } from '@prisma/client';

export class LedgerDatabase {
  /**
   * Egress: Prisma ORM database repository sink.
   */
  private prisma: PrismaClient;

  constructor() {
    this.prisma = new PrismaClient();
  }

  async saveLedgerEntry(paymentId: string, amount: number, currency: string) {
    return this.prisma.payment.create({
      data: { id: paymentId, amount, currency, timestamp: new Date() },
    });
  }

  async findPayment(paymentId: string) {
    return this.prisma.payment.findUnique({ where: { id: paymentId } });
  }
}
