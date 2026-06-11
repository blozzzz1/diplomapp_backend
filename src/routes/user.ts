import { Router, Response } from 'express';
import { PlanService, PlanType } from '../services/planService';
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth';
import { planMutationLimiter } from '../middleware/rateLimit';

const router = Router();

router.use(authenticateToken);

/** GET /api/user/plan — текущий план и лимиты использования за сегодня */
router.get('/plan', async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!req.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const { plan, error } = await PlanService.getPlan(req.userId);
    if (error) {
      res.status(500).json({ error });
      return;
    }

    let imageCountToday = 0;
    let videoCountToday = 0;
    const imageLimit = plan === 'premium' ? null : 20;
    const videoLimit = plan === 'premium' ? null : 5;

    if (plan === 'free') {
      const [img, vid] = await Promise.all([
        PlanService.getTodayImageCount(req.userId),
        PlanService.getTodayVideoCount(req.userId),
      ]);
      imageCountToday = img.count;
      videoCountToday = vid.count;
    }

    res.json({
      plan,
      imageCountToday,
      videoCountToday,
      imageLimit,
      videoLimit,
    });
  } catch (error) {
    console.error('GET /api/user/plan:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/** GET /api/user/can-use-chat-model?modelId=... — доступна ли модель чата по плану */
router.get('/can-use-chat-model', async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!req.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const modelId = req.query.modelId as string;
    if (!modelId) {
      res.status(400).json({ error: 'modelId is required' });
      return;
    }
    const { allowed, error } = await PlanService.canUseChatModel(req.userId, modelId);
    if (error) {
      res.status(500).json({ error });
      return;
    }
    res.json({ allowed });
  } catch (error) {
    console.error('GET /api/user/can-use-chat-model:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/** PUT /api/user/plan — смена плана (заглушка оплаты: можно выставить premium) */
router.put('/plan', planMutationLimiter, async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!req.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const { plan } = req.body as { plan?: string };
    if (plan !== 'free' && plan !== 'premium') {
      res.status(400).json({ error: 'plan must be "free" or "premium"' });
      return;
    }

    const { error } = await PlanService.setPlan(req.userId, plan as PlanType);
    if (error) {
      res.status(500).json({ error });
      return;
    }

    res.json({ plan });
  } catch (error) {
    console.error('PUT /api/user/plan:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/** POST /api/user/subscription/cancel — отменить подписку (переход на бесплатный план) */
router.post('/subscription/cancel', planMutationLimiter, async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!req.userId) {
      res.status(401).json({ error: 'Не авторизован' });
      return;
    }

    const { error } = await PlanService.setPlan(req.userId, 'free');
    if (error) {
      res.status(500).json({ error });
      return;
    }

    res.json({ plan: 'free' });
  } catch (err) {
    console.error('POST /api/user/subscription/cancel:', err);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

export default router;
