import { AsyncLocalStorage } from 'async_hooks';
import { indexLog, isElasticsearchEnabled } from './elasticsearch';

export const requestContext = new AsyncLocalStorage<{ requestId: string }>();

export interface RequestLogPayload {
  requestId: string;
  method: string;
  path: string;
  statusCode: number;
  durationMs: number;
  ip?: string;
  userAgent?: string;
  userId?: string;
}

export interface ActivityLogPayload {
  userId: string;
  actionType: string;
  actionDetails?: unknown;
  ipAddress?: string;
  userAgent?: string;
  requestId?: string;
}

export interface ErrorLogPayload {
  message: string;
  stack?: string;
  requestId?: string;
  path?: string;
  method?: string;
  userId?: string;
}

function timestamp(): string {
  return new Date().toISOString();
}

function getRequestId(): string | undefined {
  return requestContext.getStore()?.requestId;
}

export const appLogger = {
  request(payload: RequestLogPayload): void {
    const line = `${payload.method} ${payload.path} ${payload.statusCode} ${payload.durationMs}ms`;
    console.log(`[request] ${line}`);
    if (isElasticsearchEnabled()) {
      indexLog({
        '@timestamp': timestamp(),
        level: 'info',
        type: 'request',
        message: line,
        ...payload,
      });
    }
  },

  activity(payload: ActivityLogPayload): void {
    const requestId = payload.requestId ?? getRequestId();
    const line = `activity ${payload.userId} ${payload.actionType}`;
    console.log(`[activity] ${line}`);
    if (isElasticsearchEnabled()) {
      indexLog({
        '@timestamp': timestamp(),
        level: 'info',
        type: 'activity',
        message: line,
        userId: payload.userId,
        actionType: payload.actionType,
        actionDetails: payload.actionDetails,
        ipAddress: payload.ipAddress,
        userAgent: payload.userAgent,
        ...(requestId && { requestId }),
      });
    }
  },

  error(payload: ErrorLogPayload): void {
    const requestId = payload.requestId ?? getRequestId();
    console.error('[error]', payload.message, payload.stack || '');
    if (isElasticsearchEnabled()) {
      indexLog({
        '@timestamp': timestamp(),
        level: 'error',
        type: 'error',
        message: payload.message,
        stack: payload.stack,
        ...(requestId && { requestId }),
        ...(payload.path && { path: payload.path }),
        ...(payload.method && { method: payload.method }),
        ...(payload.userId && { userId: payload.userId }),
      });
    }
  },
};
