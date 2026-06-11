import { randomUUID } from 'crypto';
import { supabaseAdmin } from '../config/supabase';
import { ChatSession, Message, DatabaseChatSession } from '../types';

export class ChatService {
  private static async fetchSessionUpdatedAt(sessionId: string, userId: string): Promise<Date | null> {
    const { data, error } = await supabaseAdmin
      .from('chat_sessions')
      .select('updated_at')
      .eq('id', sessionId)
      .eq('user_id', userId)
      .maybeSingle();

    if (error || !data) return null;
    const ts = (data as { updated_at: string }).updated_at;
    if (!ts) return null;
    const d = new Date(ts);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  static async sessionBelongsToUser(sessionId: string, userId: string): Promise<boolean> {
    try {
      const { data, error } = await supabaseAdmin
        .from('chat_sessions')
        .select('id')
        .eq('id', sessionId)
        .eq('user_id', userId)
        .maybeSingle();

      if (error || !data) return false;
      return true;
    } catch {
      return false;
    }
  }

  static async createSession(
    userId: string,
    title: string,
    selectedModel: string
  ): Promise<{ session: ChatSession | null; error: string | null }> {
    try {
      const now = new Date();
      const session: ChatSession = {
        id: randomUUID(),
        title,
        messages: [],
        selectedModel,
        createdAt: now,
        updatedAt: now,
        userId,
      };

      // Use RPC function to bypass RLS (SECURITY DEFINER)
      const { data, error } = await supabaseAdmin.rpc('create_chat_session', {
        p_id: session.id,
        p_user_id: userId,
        p_title: session.title,
        p_selected_model: session.selectedModel,
        p_messages: session.messages,
      });

      if (error) {
        // Fallback to direct insert if RPC doesn't exist
        const { error: insertError } = await supabaseAdmin
          .from('chat_sessions')
          .insert({
            id: session.id,
            user_id: userId,
            title: session.title,
            selected_model: session.selectedModel,
            messages: JSON.stringify(session.messages),
            created_at: (session.createdAt instanceof Date ? session.createdAt : new Date(session.createdAt)).toISOString(),
            updated_at: (session.updatedAt instanceof Date ? session.updatedAt : new Date(session.updatedAt)).toISOString(),
          });

        if (insertError) {
          console.error('Error creating session:', insertError);
          return { session: null, error: insertError.message };
        }
        // Return the session we created via fallback
        return { session, error: null };
      }

      // RPC function returns the created session
      if (data && (Array.isArray(data) ? data.length > 0 : data)) {
        const row = Array.isArray(data) ? data[0] : data;
        const createdSession: ChatSession = {
          id: row.id,
          title: row.title,
          messages: row.messages || [],
          selectedModel: row.selected_model,
          createdAt: new Date(row.created_at),
          updatedAt: new Date(row.updated_at),
          userId: row.user_id,
        };
        return { session: createdSession, error: null };
      }

      return { session, error: null };
    } catch (error) {
      console.error('Error creating session:', error);
      return { session: null, error: 'An unexpected error occurred' };
    }
  }

  static async updateSession(
    session: ChatSession,
    expectedUpdatedAtIso: string | null
  ): Promise<{ error: string | null; conflict?: boolean; updatedAt?: Date }> {
    try {
      if (!session.userId) {
        return { error: 'User ID is required' };
      }

      const rpcPayload: Record<string, unknown> = {
        p_id: session.id,
        p_user_id: session.userId,
        p_title: session.title,
        p_selected_model: session.selectedModel,
        p_messages: session.messages,
      };
      if (expectedUpdatedAtIso) {
        rpcPayload.p_expected_updated_at = expectedUpdatedAtIso;
      }

      const { data: rpcData, error: rpcError } = await supabaseAdmin.rpc(
        'update_chat_session',
        rpcPayload as never
      );

      if (!rpcError) {
        const rows = Array.isArray(rpcData) ? rpcData : rpcData ? [rpcData] : [];
        if (expectedUpdatedAtIso && rows.length === 0) {
          return { error: null, conflict: true };
        }
        const row = rows[0] as Record<string, unknown> | undefined;
        const updatedRaw = row?.updated_at ?? row?.updatedAt;
        if (updatedRaw != null && String(updatedRaw).length > 0) {
          const parsed = new Date(String(updatedRaw));
          if (!Number.isNaN(parsed.getTime())) {
            return { error: null, updatedAt: parsed };
          }
        }
        const fromDb = await ChatService.fetchSessionUpdatedAt(session.id, session.userId);
        if (fromDb) {
          return { error: null, updatedAt: fromDb };
        }
        return { error: 'Не удалось прочитать время обновления сессии' };
      }

      console.warn('update_chat_session RPC failed, using direct update:', rpcError.message);

      let q = supabaseAdmin
        .from('chat_sessions')
        .update({
          title: session.title,
          selected_model: session.selectedModel,
          messages: session.messages as unknown as DatabaseChatSession['messages'],
          updated_at: new Date().toISOString(),
        })
        .eq('id', session.id)
        .eq('user_id', session.userId);

      // Окно шире RPC date_trunc: часы на ВМ / формат ответа PostgREST могут давать сдвиг относительно ISO с клиента
      if (expectedUpdatedAtIso) {
        const t = new Date(expectedUpdatedAtIso);
        const lo = new Date(t.getTime() - 2000).toISOString();
        const hi = new Date(t.getTime() + 2000).toISOString();
        q = q.gte('updated_at', lo).lte('updated_at', hi);
      }

      const { data: updatedRows, error: updateError } = await q.select('id, updated_at');

      if (updateError) {
        console.error('Error updating session:', updateError);
        return { error: updateError.message };
      }

      if (expectedUpdatedAtIso && (!updatedRows || updatedRows.length === 0)) {
        return { error: null, conflict: true };
      }

      const u = Array.isArray(updatedRows) && updatedRows[0] ? (updatedRows[0] as { updated_at: string }).updated_at : null;
      if (u) {
        return { error: null, updatedAt: new Date(u) };
      }
      const fromDb = await ChatService.fetchSessionUpdatedAt(session.id, session.userId);
      if (fromDb) {
        return { error: null, updatedAt: fromDb };
      }
      return { error: 'Обновление сессии не вернуло строку' };
    } catch (error) {
      console.error('Error updating session:', error);
      return { error: 'An unexpected error occurred' };
    }
  }

  static async deleteSession(sessionId: string, userId: string): Promise<{ error: string | null }> {
    try {
      // Use RPC function to bypass RLS (SECURITY DEFINER)
      const { data, error } = await supabaseAdmin.rpc('delete_chat_session', {
        p_id: sessionId,
        p_user_id: userId,
      });

      if (error) {
        // Fallback to direct delete if RPC doesn't exist
        const { error: deleteError } = await supabaseAdmin
          .from('chat_sessions')
          .delete()
          .eq('id', sessionId)
          .eq('user_id', userId);

        if (deleteError) {
          console.error('Error deleting session:', deleteError);
          return { error: deleteError.message };
        }
      } else if (data === false) {
        return { error: 'Session not found or unauthorized' };
      }

      return { error: null };
    } catch (error) {
      console.error('Error deleting session:', error);
      return { error: 'An unexpected error occurred' };
    }
  }

  /** Список сессий без тела messages; message_count через RPC list_chat_sessions_sidebar. */
  static async getUserSessions(userId: string): Promise<{ sessions: ChatSession[]; error: string | null }> {
    try {
      const { data: rpcRows, error: rpcError } = await supabaseAdmin.rpc('list_chat_sessions_sidebar', {
        p_user_id: userId,
      });

      if (!rpcError && Array.isArray(rpcRows) && rpcRows.length >= 0) {
        const sessions: ChatSession[] = (rpcRows as Record<string, unknown>[]).map((row) => {
          const cnt = row.message_count;
          const messageCount =
            typeof cnt === 'number' && Number.isFinite(cnt)
              ? cnt
              : typeof cnt === 'string'
                ? parseInt(cnt, 10) || 0
                : 0;
          return {
            id: row.id as string,
            title: (row.title as string) ?? '',
            messages: [],
            selectedModel: typeof row.selected_model === 'string' ? row.selected_model : '',
            createdAt: new Date(row.created_at as string),
            updatedAt: new Date(row.updated_at as string),
            userId: row.user_id as string,
            messageCount,
          };
        });
        return { sessions, error: null };
      }

      if (rpcError) {
        console.warn('list_chat_sessions_sidebar RPC failed, fallback without counts:', rpcError.message);
      }

      const { data, error } = await supabaseAdmin
        .from('chat_sessions')
        .select('id, user_id, title, selected_model, created_at, updated_at')
        .eq('user_id', userId)
        .order('updated_at', { ascending: false })
        .limit(100);

      if (error) {
        console.error('Error fetching sessions:', error);
        return { sessions: [], error: error.message };
      }

      const sessions: ChatSession[] = (data || []).map((row: any) => ({
        id: row.id,
        title: row.title ?? '',
        messages: [],
        selectedModel: typeof row.selected_model === 'string' ? row.selected_model : '',
        createdAt: new Date(row.created_at),
        updatedAt: new Date(row.updated_at),
        userId: row.user_id,
      }));

      return { sessions, error: null };
    } catch (error) {
      console.error('Error fetching sessions:', error);
      return { sessions: [], error: 'An unexpected error occurred' };
    }
  }

  static async getSession(sessionId: string, userId: string): Promise<{ session: ChatSession | null; error: string | null }> {
    try {
      // Use RPC function to bypass RLS (SECURITY DEFINER)
      const { data, error } = await supabaseAdmin.rpc('get_chat_session', {
        p_id: sessionId,
        p_user_id: userId,
      });

      if (error) {
        // Fallback to direct select if RPC doesn't exist
        const { data: fallbackData, error: fallbackError } = await supabaseAdmin
          .from('chat_sessions')
          .select('*')
          .eq('id', sessionId)
          .eq('user_id', userId)
          .single();

        if (fallbackError) {
          console.error('Error fetching session:', fallbackError);
          return { session: null, error: fallbackError.message };
        }

        if (!fallbackData) {
          return { session: null, error: 'Session not found' };
        }

        let messages: Message[] = [];
        if (fallbackData.messages) {
          if (typeof fallbackData.messages === 'string') {
            messages = JSON.parse(fallbackData.messages);
          } else {
            messages = fallbackData.messages;
          }
        }

        const session: ChatSession = {
          id: fallbackData.id,
          title: fallbackData.title,
          messages: messages.map((msg: any) => ({
            ...msg,
            timestamp: msg.timestamp ? new Date(msg.timestamp) : new Date(),
          })),
          selectedModel:
            typeof fallbackData.selected_model === 'string' ? fallbackData.selected_model : '',
          createdAt: new Date(fallbackData.created_at),
          updatedAt: new Date(fallbackData.updated_at),
          userId: fallbackData.user_id,
        };

        return { session, error: null };
      }

      if (error) {
        console.error('Error fetching session:', error);
        const err = error as unknown;
        return { session: null, error: err instanceof Error ? err.message : String(err) };
      }

      if (!data || (Array.isArray(data) ? data.length === 0 : false)) {
        return { session: null, error: 'Session not found' };
      }

      const row = Array.isArray(data) ? data[0] : data;
      let messages: Message[] = [];
      if (row.messages) {
        if (typeof row.messages === 'string') {
          messages = JSON.parse(row.messages);
        } else {
          messages = row.messages;
        }
      }

      const session: ChatSession = {
        id: row.id,
        title: row.title,
        messages: messages.map((msg: any) => ({
          ...msg,
          timestamp: msg.timestamp ? new Date(msg.timestamp) : new Date(),
        })),
        selectedModel: typeof row.selected_model === 'string' ? row.selected_model : '',
        createdAt: new Date(row.created_at),
        updatedAt: new Date(row.updated_at),
        userId: row.user_id,
      };

      return { session, error: null };
    } catch (error) {
      console.error('Error fetching session:', error);
      return { session: null, error: 'An unexpected error occurred' };
    }
  }
}

