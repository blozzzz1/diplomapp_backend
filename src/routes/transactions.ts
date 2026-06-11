import { Router, Response } from 'express';
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth';
import { getTransactionsByUser } from '../services/paymentService';

const router = Router();

router.use(authenticateToken);

/** GET /api/transactions — список транзакций текущего пользователя */
router.get('/', async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!req.userId) {
      res.status(401).json({ error: 'Не авторизован' });
      return;
    }

    const { transactions, error } = await getTransactionsByUser(req.userId);
    if (error) {
      res.status(500).json({ error });
      return;
    }

    res.json({
      transactions: transactions.map((t) => ({
        id: t.id,
        plan: t.plan,
        amount_cents: t.amount_cents,
        currency: t.currency,
        payment_method: t.payment_method,
        status: t.status,
        created_at: t.created_at,
      })),
    });
  } catch (err) {
    console.error('GET /api/transactions:', err);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

export default router;
