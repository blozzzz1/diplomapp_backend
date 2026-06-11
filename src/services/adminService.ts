import { supabaseAdmin } from '../config/supabase';
import { appLogger } from '../lib/logger';
import { invalidateModelEnabledCache } from './planService';

export interface Admin {
  id: string;
  userId: string;
  role: 'admin' | 'super_admin';
  createdAt: Date;
  createdBy?: string;
  updatedAt: Date;
}

export interface UserInfo {
  id: string;
  email: string;
  createdAt: Date;
  lastSignInAt?: Date;
  isBlocked: boolean;
  blockReason?: string;
  blockUntil?: Date;
  isAdmin: boolean;
  adminRole?: 'admin' | 'super_admin';
}

export interface UserBlock {
  id: string;
  userId: string;
  blockedBy: string;
  reason?: string;
  blockedUntil?: Date;
  isActive: boolean;
  createdAt: Date;
}

export interface SystemSetting {
  id: string;
  key: string;
  value: any;
  description?: string;
  updatedAt: Date;
  updatedBy?: string;
}

export interface ModelSetting {
  id: string;
  modelId: string;
  isEnabled: boolean;
  reason?: string;
  disabledBy?: string;
  disabledAt?: Date;
  enabledBy?: string;
  enabledAt?: Date;
  updatedAt: Date;
}

export interface UserActivity {
  id: string;
  userId: string;
  actionType: string;
  actionDetails?: any;
  ipAddress?: string;
  userAgent?: string;
  createdAt: Date;
}

function parseRegistrationEnabled(raw: unknown): boolean {
  if (raw === false || raw === 0) return false;
  if (raw === true || raw === 1) return true;
  if (typeof raw === 'string') {
    const s = raw.trim().toLowerCase();
    if (s === 'false' || s === '0') return false;
    if (s === 'true' || s === '1') return true;
    try {
      const p = JSON.parse(raw);
      if (p === false) return false;
      if (p === true) return true;
    } catch {
      /* ignore */
    }
  }
  return true;
}

export class AdminService {
  /**
   * Check if user is admin
   */
  static async isAdmin(userId: string): Promise<boolean> {
    try {
      const { data, error } = await supabaseAdmin
        .from('admins')
        .select('id')
        .eq('user_id', userId)
        .single();

      return !error && !!data;
    } catch (error) {
      console.error('Error checking admin status:', error);
      return false;
    }
  }

  /**
   * Check if user is super admin
   */
  static async isSuperAdmin(userId: string): Promise<boolean> {
    try {
      const { data, error } = await supabaseAdmin
        .from('admins')
        .select('role')
        .eq('user_id', userId)
        .eq('role', 'super_admin')
        .single();

      return !error && !!data;
    } catch (error) {
      console.error('Error checking super admin status:', error);
      return false;
    }
  }

  /**
   * Get all users with additional info
   */
  static async getAllUsers(limit: number = 50, offset: number = 0): Promise<{ users: UserInfo[]; total: number; error: string | null }> {
    try {
      // Get users from auth.users
      const { data: authUsers, error: authError } = await supabaseAdmin.auth.admin.listUsers({
        page: Math.floor(offset / limit) + 1,
        perPage: limit,
      });

      if (authError) {
        return { users: [], total: 0, error: authError.message };
      }

      const userIds = authUsers.users.map(u => u.id);

      // Get admin status
      const { data: admins } = await supabaseAdmin
        .from('admins')
        .select('user_id, role')
        .in('user_id', userIds);

      const adminMap = new Map(admins?.map(a => [a.user_id, a.role]) || []);

      // Get block status
      const { data: blocks } = await supabaseAdmin
        .from('user_blocks')
        .select('user_id, reason, blocked_until, is_active')
        .in('user_id', userIds)
        .eq('is_active', true);

      const blockMap = new Map(blocks?.map(b => [b.user_id, b]) || []);

      const users: UserInfo[] = authUsers.users.map(user => {
        const block = blockMap.get(user.id);
        return {
          id: user.id,
          email: user.email || '',
          createdAt: new Date(user.created_at),
          lastSignInAt: user.last_sign_in_at ? new Date(user.last_sign_in_at) : undefined,
          isBlocked: !!block && (!block.blocked_until || new Date(block.blocked_until) > new Date()),
          blockReason: block?.reason,
          blockUntil: block?.blocked_until ? new Date(block.blocked_until) : undefined,
          isAdmin: adminMap.has(user.id),
          adminRole: adminMap.get(user.id),
        };
      });

      // Get total count (approximate from Supabase)
      const total = authUsers.users.length; // This is approximate

      return { users, total, error: null };
    } catch (error) {
      console.error('Error getting users:', error);
      return { users: [], total: 0, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  /**
   * Get user by ID
   */
  static async getUserById(userId: string): Promise<{ user: UserInfo | null; error: string | null }> {
    try {
      const { data: authUser, error: authError } = await supabaseAdmin.auth.admin.getUserById(userId);

      if (authError || !authUser.user) {
        return { user: null, error: authError?.message || 'User not found' };
      }

      // Get admin status
      const { data: admin } = await supabaseAdmin
        .from('admins')
        .select('role')
        .eq('user_id', userId)
        .single();

      // Get block status
      const { data: block } = await supabaseAdmin
        .from('user_blocks')
        .select('reason, blocked_until, is_active')
        .eq('user_id', userId)
        .eq('is_active', true)
        .single();

      const user: UserInfo = {
        id: authUser.user.id,
        email: authUser.user.email || '',
        createdAt: new Date(authUser.user.created_at),
        lastSignInAt: authUser.user.last_sign_in_at ? new Date(authUser.user.last_sign_in_at) : undefined,
        isBlocked: !!block && (!block.blocked_until || new Date(block.blocked_until) > new Date()),
        blockReason: block?.reason,
        blockUntil: block?.blocked_until ? new Date(block.blocked_until) : undefined,
        isAdmin: !!admin,
        adminRole: admin?.role,
      };

      return { user, error: null };
    } catch (error) {
      console.error('Error getting user:', error);
      return { user: null, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  /**
   * Block user
   */
  static async blockUser(
    userId: string,
    blockedBy: string,
    reason?: string,
    blockedUntil?: Date
  ): Promise<{ error: string | null }> {
    try {
      // Deactivate existing blocks
      await supabaseAdmin
        .from('user_blocks')
        .update({ is_active: false })
        .eq('user_id', userId)
        .eq('is_active', true);

      // Create new block
      const { error } = await supabaseAdmin
        .from('user_blocks')
        .insert({
          user_id: userId,
          blocked_by: blockedBy,
          reason: reason || null,
          blocked_until: blockedUntil || null,
          is_active: true,
        });

      if (error) {
        return { error: error.message };
      }

      return { error: null };
    } catch (error) {
      console.error('Error blocking user:', error);
      return { error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  /**
   * Unblock user
   */
  static async unblockUser(userId: string): Promise<{ error: string | null }> {
    try {
      const { error } = await supabaseAdmin
        .from('user_blocks')
        .update({ is_active: false })
        .eq('user_id', userId)
        .eq('is_active', true);

      if (error) {
        return { error: error.message };
      }

      return { error: null };
    } catch (error) {
      console.error('Error unblocking user:', error);
      return { error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  /**
   * Get system settings
   */
  static async getSystemSettings(): Promise<{ settings: SystemSetting[]; error: string | null }> {
    try {
      const { data, error } = await supabaseAdmin
        .from('system_settings')
        .select('*')
        .order('key');

      if (error) {
        return { settings: [], error: error.message };
      }

      const settings: SystemSetting[] = (data || []).map(s => ({
        id: s.id,
        key: s.key,
        value: s.value,
        description: s.description,
        updatedAt: new Date(s.updated_at),
        updatedBy: s.updated_by,
      }));

      return { settings, error: null };
    } catch (error) {
      console.error('Error getting system settings:', error);
      return { settings: [], error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  /**
   * Update system setting
   */
  static async updateSystemSetting(
    key: string,
    value: any,
    updatedBy: string
  ): Promise<{ error: string | null }> {
    try {
      const { error } = await supabaseAdmin
        .from('system_settings')
        .upsert({
          key,
          value: typeof value === 'string' ? JSON.parse(value) : value,
          updated_by: updatedBy,
          updated_at: new Date().toISOString(),
        }, {
          onConflict: 'key',
        });

      if (error) {
        return { error: error.message };
      }

      return { error: null };
    } catch (error) {
      console.error('Error updating system setting:', error);
      return { error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  /**
   * Plan config (free model ids, limits) from system_settings
   */
  static async getPlanConfig(): Promise<{
    freeChatModelIds: string[];
    freeImageLimit: number;
    freeVideoLimit: number;
    disabledModelIds: string[];
    registrationEnabled: boolean;
    error: string | null;
  }> {
    try {
      const [{ data, error }, disabledRes] = await Promise.all([
        supabaseAdmin
          .from('system_settings')
          .select('key, value')
          .in('key', [
            'free_chat_model_ids',
            'free_image_limit',
            'free_video_limit',
            'registration_enabled',
          ]),
        supabaseAdmin.from('model_settings').select('model_id').eq('is_enabled', false),
      ]);

      const disabledModelIds = (disabledRes.data || [])
        .map((r: { model_id: string }) => r.model_id)
        .filter((id: string) => typeof id === 'string' && id.length > 0);

      if (error) {
        return {
          freeChatModelIds: [],
          freeImageLimit: 20,
          freeVideoLimit: 5,
          disabledModelIds,
          registrationEnabled: true,
          error: error.message,
        };
      }

      const rows = (data || []) as { key: string; value: any }[];
      const registrationEnabled = parseRegistrationEnabled(
        rows.find((r) => r.key === 'registration_enabled')?.value
      );
      const rawFreeIds = rows.find((r) => r.key === 'free_chat_model_ids')?.value;
      let freeChatModelIds: string[] = [];
      if (Array.isArray(rawFreeIds)) {
        freeChatModelIds = rawFreeIds.filter((x) => typeof x === 'string');
      } else if (typeof rawFreeIds === 'string') {
        try {
          const parsed = JSON.parse(rawFreeIds);
          freeChatModelIds = Array.isArray(parsed) ? parsed.filter((x: any) => typeof x === 'string') : [];
        } catch {
          freeChatModelIds = [];
        }
      }
      const freeImageLimit = Number(rows.find((r) => r.key === 'free_image_limit')?.value) || 20;
      const freeVideoLimit = Number(rows.find((r) => r.key === 'free_video_limit')?.value) || 5;

      return {
        freeChatModelIds,
        freeImageLimit: freeImageLimit > 0 ? freeImageLimit : 20,
        freeVideoLimit: freeVideoLimit > 0 ? freeVideoLimit : 5,
        disabledModelIds,
        registrationEnabled,
        error: null,
      };
    } catch (e) {
      console.error('getPlanConfig:', e);
      return {
        freeChatModelIds: [],
        freeImageLimit: 20,
        freeVideoLimit: 5,
        disabledModelIds: [],
        registrationEnabled: true,
        error: e instanceof Error ? e.message : 'Unknown error',
      };
    }
  }

  /**
   * Update plan config (only provided fields)
   */
  static async updatePlanConfig(
    updatedBy: string,
    data: { freeChatModelIds?: string[]; freeImageLimit?: number; freeVideoLimit?: number }
  ): Promise<{ error: string | null }> {
    try {
      if (data.freeChatModelIds !== undefined) {
        const { error } = await this.updateSystemSetting('free_chat_model_ids', data.freeChatModelIds, updatedBy);
        if (error) return { error };
      }
      if (data.freeImageLimit !== undefined) {
        const { error } = await this.updateSystemSetting('free_image_limit', data.freeImageLimit, updatedBy);
        if (error) return { error };
      }
      if (data.freeVideoLimit !== undefined) {
        const { error } = await this.updateSystemSetting('free_video_limit', data.freeVideoLimit, updatedBy);
        if (error) return { error };
      }
      return { error: null };
    } catch (e) {
      console.error('updatePlanConfig:', e);
      return { error: e instanceof Error ? e.message : 'Unknown error' };
    }
  }

  /**
   * Get model settings
   */
  static async getModelSettings(): Promise<{ settings: ModelSetting[]; error: string | null }> {
    try {
      const { data, error } = await supabaseAdmin
        .from('model_settings')
        .select('*')
        .order('model_id');

      if (error) {
        return { settings: [], error: error.message };
      }

      const settings: ModelSetting[] = (data || []).map(s => ({
        id: s.id,
        modelId: s.model_id,
        isEnabled: s.is_enabled,
        reason: s.reason,
        disabledBy: s.disabled_by,
        disabledAt: s.disabled_at ? new Date(s.disabled_at) : undefined,
        enabledBy: s.enabled_by,
        enabledAt: s.enabled_at ? new Date(s.enabled_at) : undefined,
        updatedAt: new Date(s.updated_at),
      }));

      return { settings, error: null };
    } catch (error) {
      console.error('Error getting model settings:', error);
      return { settings: [], error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  /**
   * Update model setting
   */
  static async updateModelSetting(
    modelId: string,
    isEnabled: boolean,
    updatedBy: string,
    reason?: string
  ): Promise<{ error: string | null }> {
    try {
      const updateData: any = {
        model_id: modelId,
        is_enabled: isEnabled,
        updated_at: new Date().toISOString(),
      };

      if (isEnabled) {
        updateData.enabled_by = updatedBy;
        updateData.enabled_at = new Date().toISOString();
        updateData.disabled_by = null;
        updateData.disabled_at = null;
        updateData.reason = null;
      } else {
        updateData.disabled_by = updatedBy;
        updateData.disabled_at = new Date().toISOString();
        updateData.enabled_by = null;
        updateData.enabled_at = null;
        updateData.reason = reason || null;
      }

      const { error } = await supabaseAdmin
        .from('model_settings')
        .upsert(updateData, {
          onConflict: 'model_id',
        });

      if (error) {
        return { error: error.message };
      }

      invalidateModelEnabledCache();
      return { error: null };
    } catch (error) {
      console.error('Error updating model setting:', error);
      return { error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  /**
   * Log user activity
   */
  static async logActivity(
    userId: string,
    actionType: string,
    actionDetails?: any,
    ipAddress?: string,
    userAgent?: string
  ): Promise<{ error: string | null }> {
    try {
      const { error } = await supabaseAdmin
        .from('user_activity_log')
        .insert({
          user_id: userId,
          action_type: actionType,
          action_details: actionDetails || null,
          ip_address: ipAddress || null,
          user_agent: userAgent || null,
        });

      if (error) {
        console.error('Error logging activity:', error);
        return { error: error.message };
      }

      appLogger.activity({
        userId,
        actionType,
        actionDetails,
        ipAddress,
        userAgent,
      });

      return { error: null };
    } catch (error) {
      console.error('Error logging activity:', error);
      return { error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  /**
   * Get user activity logs
   */
  static async getUserActivityLogs(
    userId?: string,
    limit: number = 100,
    offset: number = 0
  ): Promise<{ logs: UserActivity[]; total: number; error: string | null }> {
    try {
      let query = supabaseAdmin
        .from('user_activity_log')
        .select('*', { count: 'exact' })
        .order('created_at', { ascending: false })
        .range(offset, offset + limit - 1);

      if (userId) {
        query = query.eq('user_id', userId);
      }

      const { data, error, count } = await query;

      if (error) {
        return { logs: [], total: 0, error: error.message };
      }

      const logs: UserActivity[] = (data || []).map(l => ({
        id: l.id,
        userId: l.user_id,
        actionType: l.action_type,
        actionDetails: l.action_details,
        ipAddress: l.ip_address,
        userAgent: l.user_agent,
        createdAt: new Date(l.created_at),
      }));

      return { logs, total: count || 0, error: null };
    } catch (error) {
      console.error('Error getting activity logs:', error);
      return { logs: [], total: 0, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  /**
   * Add admin
   */
  static async addAdmin(
    userId: string,
    role: 'admin' | 'super_admin',
    createdBy: string
  ): Promise<{ error: string | null }> {
    try {
      const { error } = await supabaseAdmin
        .from('admins')
        .insert({
          user_id: userId,
          role,
          created_by: createdBy,
        });

      if (error) {
        return { error: error.message };
      }

      return { error: null };
    } catch (error) {
      console.error('Error adding admin:', error);
      return { error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  /**
   * Remove admin
   */
  static async removeAdmin(userId: string): Promise<{ error: string | null }> {
    try {
      const { error } = await supabaseAdmin
        .from('admins')
        .delete()
        .eq('user_id', userId);

      if (error) {
        return { error: error.message };
      }

      return { error: null };
    } catch (error) {
      console.error('Error removing admin:', error);
      return { error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  /**
   * Get all admins
   */
  static async getAdmins(): Promise<{ admins: Admin[]; error: string | null }> {
    try {
      const { data, error } = await supabaseAdmin
        .from('admins')
        .select('*')
        .order('created_at', { ascending: false });

      if (error) {
        return { admins: [], error: error.message };
      }

      const admins: Admin[] = (data || []).map(a => ({
        id: a.id,
        userId: a.user_id,
        role: a.role,
        createdAt: new Date(a.created_at),
        createdBy: a.created_by,
        updatedAt: new Date(a.updated_at),
      }));

      return { admins, error: null };
    } catch (error) {
      console.error('Error getting admins:', error);
      return { admins: [], error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }
}
