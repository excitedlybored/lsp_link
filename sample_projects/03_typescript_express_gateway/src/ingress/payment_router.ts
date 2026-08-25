import { Router, Request, Response } from 'express';
import { PaymentService } from '../service/payment_service';

export const paymentRouter = Router();
const paymentService = new PaymentService();

/**
 * Ingress: HTTP REST API for initiating payments.
 */
paymentRouter.post('/api/v1/payments/send', async (req: Request, res: Response) => {
  const result = await paymentService.sendPayment(req.body);
  res.json({ status: 'PROCESSED', paymentId: result });
});

/**
 * Ingress: HTTP REST API for querying payment status.
 */
paymentRouter.get('/api/v1/payments/:id', async (req: Request, res: Response) => {
  const record = await paymentService.getPayment(req.params.id);
  res.json(record);
});
