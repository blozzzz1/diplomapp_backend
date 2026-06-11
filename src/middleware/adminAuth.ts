import { Request, Response, NextFunction } from 'express';
import { AuthenticatedRequest } from './auth';
import { AdminService } from '../services/adminService';

export interface AdminRequest extends AuthenticatedRequest {
  isSuperAdmin?: boolean;
}

/**
 * Middleware to check if user is admin
 */
export const requireAdmin = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    if (!req.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const isAdmin = await AdminService.isAdmin(req.userId);
    if (!isAdmin) {
      res.status(403).json({ error: 'Forbidden: Admin access required' });
      return;
    }

    next();
  } catch (error) {
    console.error('Error in requireAdmin middleware:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

/**
 * Middleware to check if user is super admin
 */
export const requireSuperAdmin = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    if (!req.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const isSuperAdmin = await AdminService.isSuperAdmin(req.userId);
    if (!isSuperAdmin) {
      res.status(403).json({ error: 'Forbidden: Super admin access required' });
      return;
    }

    (req as AdminRequest).isSuperAdmin = true;
    next();
  } catch (error) {
    console.error('Error in requireSuperAdmin middleware:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};
