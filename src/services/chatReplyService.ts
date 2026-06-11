import { randomUUID } from 'crypto';
import { ChatService } from './chatService';
import { completeChat, ChatCompletionError, ChatApiMessage } from '../lib/chatCompletion';
import { ChatSession, Message } from '../types';

const PENDING_PLACEHOLDER = '…';

function toIso(d: string | Date | undefined): string | null {
  if (!d) return null;
  const parsed = d instanceof Date ? d : new Date(d);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function stripPendingFromHistory(messages: Message[]): Message[] {
  return messages.filter((m) => !m.pending);
}

function isReplyInProgress(messages: Message[]): boolean {
  const last = messages[messages.length - 1];
  return Boolean(last && last.role === 'assistant' && last.pending);
}

export type SessionReplyResult =
  | { ok: true; session: ChatSession; inProgress?: false }
  | { ok: true; session: ChatSession; inProgress: true }
  | { ok: false; status: number; error: string; code?: string };

export async function processSessionReply(params: {
  userId: string;
  sessionId: string;
  userMessage: Message;
  model: string;
  apiMessages: ChatApiMessage[];
}): Promise<SessionReplyResult> {
  const { userId, sessionId, userMessage, model, apiMessages } = params;

  const { session: existing, error: loadErr } = await ChatService.getSession(sessionId, userId);
  if (loadErr || !existing) {
    return { ok: false, status: 404, error: loadErr || 'Session not found' };
  }

  if (isReplyInProgress(existing.messages)) {
    return { ok: true, session: existing, inProgress: true };
  }

  const history = stripPendingFromHistory(existing.messages);
  const placeholderId = randomUUID();
  const placeholder: Message = {
    id: placeholderId,
    role: 'assistant',
    content: PENDING_PLACEHOLDER,
    pending: true,
    timestamp: new Date(),
    model,
  };

  const isFirstUser =
    history.filter((m) => m.role === 'user').length === 0;
  const titleFromUser =
    isFirstUser && userMessage.content
      ? userMessage.content.length > 50
        ? `${userMessage.content.substring(0, 50)}...`
        : userMessage.content
      : existing.title;

  const sessionWithUser: ChatSession = {
    ...existing,
    userId,
    title: titleFromUser,
    selectedModel: model,
    messages: [...history, userMessage, placeholder],
    updatedAt: new Date(),
  };

  const ifMatch = toIso(existing.updatedAt);
  const saveUser = await ChatService.updateSession(sessionWithUser, ifMatch);
  if (saveUser.conflict) {
    const { session: fresh } = await ChatService.getSession(sessionId, userId);
    if (fresh && isReplyInProgress(fresh.messages)) {
      return { ok: true, session: fresh, inProgress: true };
    }
    return { ok: false, status: 409, error: 'Session was updated elsewhere', code: 'VERSION_CONFLICT' };
  }
  if (saveUser.error) {
    return { ok: false, status: 500, error: saveUser.error };
  }

  const afterUserSave: ChatSession = {
    ...sessionWithUser,
    updatedAt: saveUser.updatedAt || sessionWithUser.updatedAt,
  };

  let assistantContent: string;
  try {
    assistantContent = await completeChat(userId, model, apiMessages);
  } catch (err) {
    const msg =
      err instanceof ChatCompletionError
        ? err.message
        : err instanceof Error
          ? err.message
          : 'Неизвестная ошибка';
    assistantContent = `Извините, произошла ошибка: ${msg}`;
  }

  const assistantMessage: Message = {
    id: placeholderId,
    role: 'assistant',
    content: assistantContent,
    pending: false,
    timestamp: new Date(),
    model,
  };

  const finalMessages = afterUserSave.messages.map((m) =>
    m.id === placeholderId ? assistantMessage : m
  );

  const sessionFinal: ChatSession = {
    ...afterUserSave,
    messages: finalMessages,
    updatedAt: new Date(),
  };

  const saveFinal = await ChatService.updateSession(
    sessionFinal,
    toIso(afterUserSave.updatedAt)
  );
  if (saveFinal.error && !saveFinal.conflict) {
    return { ok: false, status: 500, error: saveFinal.error };
  }

  const { session: reloaded } = await ChatService.getSession(sessionId, userId);
  return {
    ok: true,
    session: reloaded || {
      ...sessionFinal,
      updatedAt: saveFinal.updatedAt || sessionFinal.updatedAt,
    },
  };
}
