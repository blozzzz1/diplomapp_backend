import { Request, Response, NextFunction } from 'express';
import { supabaseAdmin } from '../config/supabase';
import { SecurityService } from '../services/securityService';

export interface AuthenticatedRequest extends Request {
  userId?: string;
  user?: {
    id: string;
    email: string;
  };
}

const AUTH_CACHE_TTL_MS = 60 * 1000; // 1 минута
const AUTH_CACHE_MAX_SIZE = 500;
const authCache = new Map<string, { userId: string; email: string; cachedAt: number }>();

function getCachedAuth(token: string): { userId: string; email: string } | null {
  const entry = authCache.get(token);
  if (!entry) return null;
  if (Date.now() - entry.cachedAt > AUTH_CACHE_TTL_MS) {
    authCache.delete(token);
    return null;
  }
  return { userId: entry.userId, email: entry.email };
}

function setCachedAuth(token: string, userId: string, email: string): void {
  if (authCache.size >= AUTH_CACHE_MAX_SIZE) {
    const oldest = [...authCache.entries()].sort((a, b) => a[1].cachedAt - b[1].cachedAt)[0];
    if (oldest) authCache.delete(oldest[0]);
  }
  authCache.set(token, { userId, email, cachedAt: Date.now() });
}

export const authenticateToken = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const authHeader = req.headers.authorization;
    const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

    if (!token) {
      res.status(401).json({ error: 'No token provided' });
      return;
    }

    const cached = getCachedAuth(token);
    if (cached) {
      const { blocked, reason } = await SecurityService.getActiveBlockForUser(cached.userId);
      if (blocked) {
        res.status(403).json({
          error: reason
            ? `Аккаунт заблокирован: ${reason}`
            : 'Аккаунт заблокирован. Обратитесь в поддержку.',
          code: 'USER_BLOCKED',
        });
        return;
      }
      req.userId = cached.userId;
      req.user = { id: cached.userId, email: cached.email };
      next();
      return;
    }

    const { data: { user }, error } = await supabaseAdmin.auth.getUser(token);

    if (error || !user) {
      res.status(401).json({ error: 'Invalid or expired token' });
      return;
    }

    const { blocked, reason } = await SecurityService.getActiveBlockForUser(user.id);
    if (blocked) {
      res.status(403).json({
        error: reason
          ? `Аккаунт заблокирован: ${reason}`
          : 'Аккаунт заблокирован. Обратитесь в поддержку.',
        code: 'USER_BLOCKED',
      });
      return;
    }

    setCachedAuth(token, user.id, user.email || '');
    req.userId = user.id;
    req.user = { id: user.id, email: user.email || '' };
    next();
  } catch (error) {
    console.error('Authentication error:', error);
    res.status(401).json({ error: 'Authentication failed' });
  }
};


