import { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';
import { requestContext, appLogger } from '../lib/logger';

export interface RequestWithId extends Request {
  id?: string;
}

function getIp(req: Request): string | undefined {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string') {
    return forwarded.split(',')[0].trim();
  }
  return req.socket?.remoteAddress;
}

export function requestLogger(req: RequestWithId, res: Response, next: NextFunction): void {
  const requestId = randomUUID();
  req.id = requestId;
  const start = Date.now();

  const run = () => {
    res.on('finish', () => {
      const durationMs = Date.now() - start;
      const userId = (req as Request & { userId?: string }).userId;
      appLogger.request({
        requestId,
        method: req.method,
        path: req.path,
        statusCode: res.statusCode,
        durationMs,
        ip: getIp(req),
        userAgent: req.headers['user-agent'],
        ...(userId && { userId }),
      });
    });
    next();
  };

  requestContext.run({ requestId }, run);
}
