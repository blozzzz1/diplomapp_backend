import { randomUUID } from 'crypto';
import { Router, Response } from 'express';
import { ChatService } from '../services/chatService';
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth';
import { AdminService } from '../services/adminService';
import { StorageService } from '../services/storageService';
import { ChatSession } from '../types';
import { aiChatLimiter, chatAttachmentUploadLimiter } from '../middleware/rateLimit';
import { processSessionReply } from '../services/chatReplyService';
import { Message } from '../types';

const router = Router();

// All routes require authentication
router.use(authenticateToken);

// POST /api/chat/attachments — загрузка binary в Storage; в JSON сессии сохраняются только URL
router.post('/attachments', chatAttachmentUploadLimiter, async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!req.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const { sessionId, mimeType, base64, filename } = req.body as {
      sessionId?: string;
      mimeType?: string;
      base64?: string;
      filename?: string;
    };

    if (!sessionId || typeof sessionId !== 'string') {
      res.status(400).json({ error: 'sessionId is required' });
      return;
    }
    if (!base64 || typeof base64 !== 'string') {
      res.status(400).json({ error: 'base64 is required' });
      return;
    }

    const owns = await ChatService.sessionBelongsToUser(sessionId, req.userId);
    if (!owns) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    let buffer: Buffer;
    try {
      buffer = Buffer.from(base64, 'base64');
    } catch {
      res.status(400).json({ error: 'Invalid base64' });
      return;
    }

    const mime = typeof mimeType === 'string' && mimeType.trim() ? mimeType.trim() : 'application/octet-stream';
    const extFromName = typeof filename === 'string' && filename.includes('.') ? filename.split('.').pop() || '' : '';
    const extFromMime =
      mime === 'image/png'
        ? 'png'
        : mime === 'image/jpeg' || mime === 'image/jpg'
          ? 'jpg'
          : mime === 'image/webp'
            ? 'webp'
            : mime === 'image/gif'
              ? 'gif'
              : mime === 'application/pdf'
                ? 'pdf'
                : mime === 'video/mp4'
                  ? 'mp4'
                  : mime === 'audio/wav'
                    ? 'wav'
                    : mime === 'audio/mpeg' || mime === 'audio/mp3'
                      ? 'mp3'
                      : 'bin';

    const ext = (extFromName || extFromMime).slice(0, 8) || 'bin';
    const uploadId = randomUUID();

    const { url, error } = await StorageService.uploadChatAttachment(
      buffer,
      req.userId,
      sessionId,
      uploadId,
      mime,
      ext
    );

    if (error || !url) {
      res.status(500).json({ error: error || 'Upload failed' });
      return;
    }

    res.json({ url, mimeType: mime });
  } catch (e) {
    console.error('POST /attachments:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/chat/sessions - Get all user sessions
router.get('/sessions', async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!req.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const { sessions, error } = await ChatService.getUserSessions(req.userId);

    if (error) {
      res.status(500).json({ error });
      return;
    }

    res.json({ sessions });
  } catch (error) {
    console.error('Error in GET /sessions:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/chat/sessions/:id - Get specific session
router.get('/sessions/:id', async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!req.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const { id } = req.params;
    const { session, error } = await ChatService.getSession(id, req.userId);

    if (error) {
      res.status(404).json({ error });
      return;
    }

    res.json({ session });
  } catch (error) {
    console.error('Error in GET /sessions/:id:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/chat/sessions - Create new session
router.post('/sessions', async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!req.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const { title, selectedModel } = req.body;

    if (!title || !selectedModel) {
      res.status(400).json({ error: 'Title and selectedModel are required' });
      return;
    }

    const { session, error } = await ChatService.createSession(
      req.userId,
      title,
      selectedModel
    );

    if (error || !session) {
      res.status(500).json({ error: error || 'Failed to create session' });
      return;
    }

    // Send response first, then log activity asynchronously (don't block response)
    res.status(201).json({ session });

    // Log activity asynchronously (fire and forget)
    const ipAddress = req.ip || req.headers['x-forwarded-for'] as string || req.socket.remoteAddress;
    const userAgent = req.headers['user-agent'];
    AdminService.logActivity(
      req.userId!,
      'chat_session_created',
      { sessionId: session.id, title: session.title, model: session.selectedModel },
      ipAddress,
      userAgent
    ).catch(err => {
      console.error('Error logging activity (non-blocking):', err);
    });
  } catch (error) {
    console.error('Error in POST /sessions:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/chat/sessions/:id/reply — сохранить user message, вызвать AI на сервере, вернуть сессию
router.post('/sessions/:id/reply', aiChatLimiter, async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!req.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const { id: sessionId } = req.params;
    const body = req.body as {
      userMessage?: Message;
      model?: string;
      apiMessages?: Array<{ role: string; content: unknown }>;
    };

    if (!body.userMessage || typeof body.userMessage !== 'object') {
      res.status(400).json({ error: 'userMessage is required' });
      return;
    }
    if (!body.model || typeof body.model !== 'string' || !body.model.trim()) {
      res.status(400).json({ error: 'model is required' });
      return;
    }
    if (!Array.isArray(body.apiMessages) || body.apiMessages.length === 0) {
      res.status(400).json({ error: 'apiMessages array is required' });
      return;
    }

    const owns = await ChatService.sessionBelongsToUser(sessionId, req.userId);
    if (!owns) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    // Не привязываемся к req.on('close') — AI и сохранение завершаются даже при закрытии вкладки
    const result = await processSessionReply({
      userId: req.userId,
      sessionId,
      userMessage: body.userMessage,
      model: body.model.trim(),
      apiMessages: body.apiMessages,
    });

    if (!result.ok) {
      res.status(result.status).json({ error: result.error, code: result.code });
      return;
    }

    if (result.inProgress) {
      res.status(409).json({
        error: 'Ответ уже генерируется для этой сессии',
        code: 'REPLY_IN_PROGRESS',
        session: result.session,
      });
      return;
    }

    if (!res.writableEnded) {
      res.json({ session: result.session });
    }
  } catch (error) {
    console.error('Error in POST /sessions/:id/reply:', error);
    if (!res.writableEnded) {
      res.status(500).json({ error: 'Internal server error' });
    }
  }
});

// PUT /api/chat/sessions/:id - Update session
router.put('/sessions/:id', async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!req.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const { id } = req.params;
    const body = req.body as Partial<ChatSession> & { ifMatchUpdatedAt?: string };

    if (body.id && body.id !== id) {
      res.status(400).json({ error: 'Session id mismatch' });
      return;
    }

    if (!Array.isArray(body.messages)) {
      res.status(400).json({ error: 'messages array is required' });
      return;
    }

    const updatedSession: ChatSession = {
      id,
      userId: req.userId,
      title: typeof body.title === 'string' ? body.title : '',
      selectedModel: typeof body.selectedModel === 'string' ? body.selectedModel : '',
      messages: body.messages,
      createdAt: body.createdAt ? new Date(body.createdAt as string) : new Date(),
      updatedAt: body.updatedAt ? new Date(body.updatedAt as string) : new Date(),
    };

    const ifMatch =
      typeof body.ifMatchUpdatedAt === 'string' && body.ifMatchUpdatedAt.trim().length > 0
        ? body.ifMatchUpdatedAt.trim()
        : null;

    const { error, conflict, updatedAt } = await ChatService.updateSession(updatedSession, ifMatch);

    if (conflict) {
      res.status(409).json({ error: 'Session was updated elsewhere', code: 'VERSION_CONFLICT' });
      return;
    }

    if (error) {
      res.status(500).json({ error });
      return;
    }

    const responseSession: ChatSession = {
      ...updatedSession,
      updatedAt: updatedAt || new Date(),
    };

    res.json({ session: responseSession });

    const ipAddress = req.ip || req.headers['x-forwarded-for'] as string || req.socket.remoteAddress;
    const userAgent = req.headers['user-agent'];
    AdminService.logActivity(
      req.userId!,
      'chat_session_updated',
      {
        sessionId: id,
        title: responseSession.title,
        model: responseSession.selectedModel,
        messageCount: responseSession.messages?.length || 0,
      },
      ipAddress,
      userAgent
    ).catch((err) => {
      console.error('Error logging activity (non-blocking):', err);
    });
  } catch (error) {
    console.error('Error in PUT /sessions/:id:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/chat/sessions/:id - Delete session
router.delete('/sessions/:id', async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!req.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const { id } = req.params;
    const { error } = await ChatService.deleteSession(id, req.userId);

    if (error) {
      res.status(500).json({ error });
      return;
    }

    // Send response first, then log activity asynchronously
    res.json({ success: true });

    // Log activity asynchronously (fire and forget)
    const ipAddress = req.ip || req.headers['x-forwarded-for'] as string || req.socket.remoteAddress;
    const userAgent = req.headers['user-agent'];
    AdminService.logActivity(
      req.userId!,
      'chat_session_deleted',
      { sessionId: id },
      ipAddress,
      userAgent
    ).catch(err => {
      console.error('Error logging activity (non-blocking):', err);
    });
  } catch (error) {
    console.error('Error in DELETE /sessions/:id:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;


