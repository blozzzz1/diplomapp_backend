import { Router, Response } from 'express';
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth';
import { PlanService, PlanType } from '../services/planService';
import {
  createTransaction,
  getTransactionsByUser,
  type PaymentMethod,
} from '../services/paymentService';
import { paymentMutationLimiter } from '../middleware/rateLimit';

const router = Router();

router.use(authenticateToken);

/** POST /api/payment — оформить оплату (карта или СБП), условно завершаем и выставляем премиум */
router.post('/', paymentMutationLimiter, async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!req.userId) {
      res.status(401).json({ error: 'Не авторизован' });
      return;
    }

    const { plan, paymentMethod } = req.body as { plan?: string; paymentMethod?: string };
    if (plan !== 'premium') {
      res.status(400).json({ error: 'Поддерживается только план premium' });
      return;
    }
    if (paymentMethod !== 'card' && paymentMethod !== 'sbp') {
      res.status(400).json({ error: 'Укажите способ оплаты: card или sbp' });
      return;
    }

    const { transaction, error: txError } = await createTransaction(
      req.userId,
      'premium',
      paymentMethod as PaymentMethod
    );
    if (txError || !transaction) {
      res.status(500).json({ error: txError || 'Не удалось создать платёж' });
      return;
    }

    const { error: planError } = await PlanService.setPlan(req.userId, 'premium' as PlanType);
    if (planError) {
      res.status(500).json({ error: planError });
      return;
    }

    res.status(201).json({
      transaction: {
        id: transaction.id,
        plan: transaction.plan,
        amount_cents: transaction.amount_cents,
        currency: transaction.currency,
        payment_method: transaction.payment_method,
        status: transaction.status,
        created_at: transaction.created_at,
      },
    });
  } catch (err) {
    console.error('POST /api/payment:', err);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

export default router;
