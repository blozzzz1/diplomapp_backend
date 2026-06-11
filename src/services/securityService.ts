import { supabaseAdmin } from '../config/supabase';

export class SecurityService {
  /** Активная блокировка: is_active и срок не истёк (если задан). */
  static async getActiveBlockForUser(userId: string): Promise<{ blocked: boolean; reason?: string }> {
    const { data, error } = await supabaseAdmin
      .from('user_blocks')
      .select('reason, blocked_until')
      .eq('user_id', userId)
      .eq('is_active', true)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error || !data) {
      return { blocked: false };
    }

    if (data.blocked_until) {
      const until = new Date(data.blocked_until as string);
      if (until.getTime() <= Date.now()) {
        return { blocked: false };
      }
    }

    return {
      blocked: true,
      reason: typeof data.reason === 'string' ? data.reason : undefined,
    };
  }
}
