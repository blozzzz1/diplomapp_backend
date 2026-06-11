import rateLimit from 'express-rate-limit';
import type { Request } from 'express';

function resolveClientKey(req: Request): string {
  const withUser = req as Request & { userId?: string };
  if (withUser.userId) return `u:${withUser.userId}`;
  return `ip:${req.ip || 'unknown'}`;
}

function isSafeReadMethod(method: string): boolean {
  return method === 'GET' || method === 'HEAD' || method === 'OPTIONS';
}

function createJsonLimiter(options: {
  windowMs: number;
  max: number;
  message: string;
  keyByUser?: boolean;
  skip?: (req: Request) => boolean;
}) {
  const { windowMs, max, message, keyByUser = true, skip } = options;
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => req.method === 'OPTIONS' || Boolean(skip?.(req)),
    keyGenerator: keyByUser ? resolveClientKey : (req) => `ip:${req.ip || 'unknown'}`,
    handler: (req, res) => {
      const withRateLimit = req as Request & { rateLimit?: { resetTime?: Date } };
      const retryAfterSec = Math.max(
        1,
        Math.ceil(
          ((withRateLimit.rateLimit?.resetTime?.getTime() ?? Date.now() + windowMs) - Date.now()) / 1000
        )
      );
      res.status(429).json({
        error: message,
        code: 'RATE_LIMIT_EXCEEDED',
        retryAfter: retryAfterSec,
      });
    },
  });
}

export const apiGlobalLimiter = createJsonLimiter({
  windowMs: 15 * 60 * 1000,
  max: 1200,
  message: 'Слишком много запросов к API. Попробуйте позже.',
  keyByUser: false,
  // Не ограничиваем безопасные read-запросы, чтобы не ломать подгрузку данных в интерфейсе.
  // Критичные маршруты (AI, оплаты, админка, загрузки) защищены отдельными limiter'ами ниже.
  skip: (req) => isSafeReadMethod(req.method),
});

export const adminLimiter = createJsonLimiter({
  windowMs: 15 * 60 * 1000,
  max: 180,
  message: 'Слишком много админ-запросов. Попробуйте позже.',
});

export const paymentMutationLimiter = createJsonLimiter({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: 'Слишком много попыток оплаты. Попробуйте позже.',
});

export const planMutationLimiter = createJsonLimiter({
  windowMs: 15 * 60 * 1000,
  max: 30,
  message: 'Слишком много запросов изменения тарифа. Попробуйте позже.',
});

export const chatAttachmentUploadLimiter = createJsonLimiter({
  windowMs: 10 * 60 * 1000,
  max: 40,
  message: 'Слишком много загрузок вложений. Попробуйте позже.',
});

export const aiGeneralLimiter = createJsonLimiter({
  windowMs: 15 * 60 * 1000,
  max: 220,
  message: 'Слишком много AI-запросов. Попробуйте позже.',
});

export const aiChatLimiter = createJsonLimiter({
  windowMs: 10 * 60 * 1000,
  max: 60,
  message: 'Слишком много запросов в чат AI. Попробуйте позже.',
});

export const aiImageLimiter = createJsonLimiter({
  windowMs: 10 * 60 * 1000,
  max: 40,
  message: 'Слишком много запросов генерации изображений. Попробуйте позже.',
});

export const aiVideoCreateLimiter = createJsonLimiter({
  windowMs: 15 * 60 * 1000,
  max: 16,
  message: 'Слишком много запросов генерации видео. Попробуйте позже.',
});

export const aiVideoStatusLimiter = createJsonLimiter({
  windowMs: 10 * 60 * 1000,
  max: 240,
  message: 'Слишком много запросов статуса видео. Попробуйте позже.',
});

export const aiVideoContentLimiter = createJsonLimiter({
  windowMs: 10 * 60 * 1000,
  max: 60,
  message: 'Слишком много запросов скачивания видео. Попробуйте позже.',
});
