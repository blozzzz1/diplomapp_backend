/**
 * AI proxy routes: all requests to Intelligence.io and AITunnel go through backend
 * so API keys are never exposed to the frontend.
 * Mounted before express.json() so multipart body is available for edits/videos.
 */
import { Router, Request, Response as ExpressResponse } from 'express';
import busboy from 'busboy';
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth';
import { PlanService } from '../services/planService';
import { forwardMultipartAfterModelCheck } from '../lib/multipartAitunnelForward';
import {
  aiChatLimiter,
  aiGeneralLimiter,
  aiImageLimiter,
  aiVideoContentLimiter,
  aiVideoCreateLimiter,
  aiVideoStatusLimiter,
} from '../middleware/rateLimit';
import { proxyChatCompletion } from '../lib/chatCompletion';

const IMAGE_TIMEOUT_MS = 90000;   // 1.5 min — генерация изображения
const VIDEO_CREATE_TIMEOUT_MS = 180000; // 3 min — создание видео
const VIDEO_TIMEOUT_MS = 30000;   // 30 сек — статус видео
const VIDEO_CONTENT_TIMEOUT_MS = 120000; // 2 min — скачивание видео

/** Fetch API Response (global fetch), not Express Response. */
function fetchWithTimeout(
  url: string,
  options: RequestInit & { timeoutMs?: number }
): Promise<Response> {
  const { timeoutMs = 60000, ...fetchOptions } = options;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  return globalThis.fetch(url, { ...fetchOptions, signal: controller.signal }).finally(() =>
    clearTimeout(timeout)
  );
}

function readJsonBody(req: Request): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      try {
        const body = Buffer.concat(chunks).toString('utf8');
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function parseBooleanLoose(raw: string | undefined): boolean | undefined {
  if (raw == null) return undefined;
  const v = raw.trim().toLowerCase();
  if (v === 'true' || v === '1') return true;
  if (v === 'false' || v === '0') return false;
  return undefined;
}

function parseNumberLoose(raw: string | undefined): number | undefined {
  if (raw == null) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

async function readVideoMultipartAsJson(req: Request): Promise<Record<string, unknown>> {
  const MAX_REFERENCE_BYTES = 15 * 1024 * 1024;
  return await new Promise<Record<string, unknown>>((resolve, reject) => {
    const fields = new Map<string, string>();
    let referenceDataUrl: string | null = null;
    let hadAnyFile = false;
    let fileTooLarge = false;

    const bb = busboy({
      headers: req.headers,
      limits: { fileSize: MAX_REFERENCE_BYTES, files: 1 },
    });

    bb.on('field', (name, value) => {
      fields.set(name, value);
    });

    bb.on('file', (fieldname, file, info) => {
      hadAnyFile = true;
      const chunks: Buffer[] = [];
      file.on('data', (chunk: Buffer) => chunks.push(chunk));
      file.on('limit', () => {
        fileTooLarge = true;
      });
      file.on('end', () => {
        if (fileTooLarge) return;
        if (fieldname !== 'input_reference') return;
        const buffer = Buffer.concat(chunks);
        const mime = (info.mimeType || 'image/png').split(';')[0].trim() || 'image/png';
        referenceDataUrl = `data:${mime};base64,${buffer.toString('base64')}`;
      });
    });

    bb.on('error', reject);
    bb.on('finish', () => {
      if (fileTooLarge) {
        reject(new Error('FILE_TOO_LARGE'));
        return;
      }
      const model = (fields.get('model') || '').trim();
      const prompt = (fields.get('prompt') || '').trim();
      const payload: Record<string, unknown> = { model, prompt };

      const size = fields.get('size');
      const resolution = fields.get('resolution');
      const aspectRatio = fields.get('aspect_ratio');
      const duration = parseNumberLoose(fields.get('duration'));
      const seconds = parseNumberLoose(fields.get('seconds'));
      const seed = parseNumberLoose(fields.get('seed'));
      const generateAudio = parseBooleanLoose(fields.get('generate_audio'));
      const negativePrompt = fields.get('negative_prompt');

      if (size) payload.size = size;
      if (resolution) payload.resolution = resolution;
      if (aspectRatio) payload.aspect_ratio = aspectRatio;
      if (duration !== undefined) payload.duration = duration;
      if (seconds !== undefined) payload.seconds = seconds;
      if (seed !== undefined) payload.seed = seed;
      if (generateAudio !== undefined) payload.generate_audio = generateAudio;
      if (negativePrompt) payload.negative_prompt = negativePrompt;

      if (!referenceDataUrl) {
        const ref = (fields.get('input_reference') || '').trim();
        if (ref) {
          referenceDataUrl = ref;
        }
      }
      if (referenceDataUrl) {
        payload.input_references = [{ type: 'image_url', image_url: { url: referenceDataUrl } }];
      } else if (!hadAnyFile) {
        const rawInputReferences = fields.get('input_references');
        if (rawInputReferences) {
          try {
            payload.input_references = JSON.parse(rawInputReferences);
          } catch {
            // ignore malformed legacy field from client
          }
        }
      }

      resolve(payload);
    });

    req.pipe(bb);
  });
}

const AITUNNEL_BASE = 'https://api.aitunnel.ru/v1';

const router = Router();

router.use(authenticateToken);
router.use(aiGeneralLimiter);

// POST /api/ai/chat/completions — proxy chat (Intelligence or AITunnel)
router.post('/chat/completions', aiChatLimiter, async (req: AuthenticatedRequest, res: ExpressResponse) => {
  try {
    const body = await readJsonBody(req);
    const { status, data } = await proxyChatCompletion(req.userId!, body);
    res.status(status).json(data);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Proxy request failed';
    if (msg.includes('abort')) {
      res.status(504).json({ error: { message: 'Таймаут запроса к AI. Попробуйте короче сообщение или позже.' } });
      return;
    }
    console.error('AI proxy chat error:', err);
    res.status(500).json({ error: { message: 'Proxy request failed' } });
  }
});

// POST /api/ai/images/generations — proxy image generation (AITunnel)
router.post('/images/generations', aiImageLimiter, async (req: AuthenticatedRequest, res: ExpressResponse) => {
  try {
    const body = await readJsonBody(req);
    const apiKey = process.env.AITUNNEL_API_KEY;
    if (!apiKey) {
      res.status(500).json({ error: { message: 'AITUNNEL_API_KEY is not configured' } });
      return;
    }

    const model = (body?.model as string | undefined)?.trim();
    if (!model) {
      res.status(400).json({ error: { message: 'Поле model обязательно' } });
      return;
    }
    if (!(await PlanService.isModelGloballyEnabled(model))) {
      res.status(403).json({
        error: {
          message: 'Эта модель отключена администратором.',
          code: 'MODEL_DISABLED',
        },
      });
      return;
    }

    const response = await fetchWithTimeout(`${AITUNNEL_BASE}/images/generations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      timeoutMs: IMAGE_TIMEOUT_MS,
    });

    const text = await response.text();
    try {
      const data = JSON.parse(text);
      res.status(response.status).json(data);
    } catch {
      res.status(response.status).contentType('application/json').send(text);
    }
  } catch (err) {
    console.error('AI proxy images/generations error:', err);
    res.status(500).json({ error: { message: 'Proxy request failed' } });
  }
});

// POST /api/ai/images/edits — proxy image edit (multipart, AITunnel)
router.post('/images/edits', aiImageLimiter, async (req: AuthenticatedRequest, res: ExpressResponse) => {
  try {
    const apiKey = process.env.AITUNNEL_API_KEY;
    if (!apiKey) {
      res.status(500).json({ error: { message: 'AITUNNEL_API_KEY is not configured' } });
      return;
    }

    const forwarded = await forwardMultipartAfterModelCheck(req, `${AITUNNEL_BASE}/images/edits`, {
      apiKey,
      timeoutMs: IMAGE_TIMEOUT_MS,
      fetchWithTimeout,
    });

    if (!forwarded.ok) {
      res.status(forwarded.status).json(forwarded.body);
      return;
    }

    const response = forwarded.upstream;

    const respContentType = response.headers.get('content-type');
    if (respContentType) res.setHeader('Content-Type', respContentType);
    res.status(response.status);
    if (response.body) {
      const reader = response.body.getReader();
      const pump = async () => {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(Buffer.from(value));
        }
        res.end();
      };
      await pump();
    } else {
      res.end();
    }
  } catch (err) {
    console.error('AI proxy images/edits error:', err);
    if (err instanceof Error && err.message === 'FILE_TOO_LARGE') {
      res.status(413).json({ error: { message: 'Файл слишком большой' } });
      return;
    }
    const isTimeout = err instanceof Error && err.name === 'AbortError';
    res.status(isTimeout ? 504 : 500).json({
      error: { message: isTimeout ? 'Image edit request timed out' : 'Proxy request failed' },
    });
  }
});

// POST /api/ai/videos — proxy video creation (JSON or multipart, AITunnel)
router.post('/videos', aiVideoCreateLimiter, async (req: AuthenticatedRequest, res: ExpressResponse) => {
  try {
    const apiKey = process.env.AITUNNEL_API_KEY;
    if (!apiKey) {
      res.status(500).json({ error: { message: 'AITUNNEL_API_KEY is not configured' } });
      return;
    }

    const contentType = String(req.headers['content-type'] || '').toLowerCase();
    const body = contentType.includes('multipart/form-data')
      ? await readVideoMultipartAsJson(req)
      : await readJsonBody(req);

    const model = typeof body.model === 'string' ? body.model.trim() : '';
    if (!model) {
      res.status(400).json({ error: { message: 'Поле model обязательно' } });
      return;
    }
    if (!(await PlanService.isModelGloballyEnabled(model))) {
      res.status(403).json({
        error: {
          message: 'Эта модель отключена администратором.',
          code: 'MODEL_DISABLED',
        },
      });
      return;
    }
    body.model = model;
    const response = await fetchWithTimeout(`${AITUNNEL_BASE}/videos`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      timeoutMs: VIDEO_CREATE_TIMEOUT_MS,
    });

    const responseText = await response.text();
    let bodyToSend = responseText;
    let data: Record<string, unknown> = {};
    try {
      data = responseText ? JSON.parse(responseText) : {};
    } catch (_) {
      data = {};
    }

    // AITunnel иногда возвращает id без префикса video_ (например UUID у wan2.6) — нормализуем для клиента
    if (response.ok && data.id != null && !String(data.id).startsWith('video_')) {
      data.id = 'video_' + String(data.id);
      bodyToSend = JSON.stringify(data);
    }

    const respContentType = response.headers.get('content-type');
    if (respContentType) res.setHeader('Content-Type', respContentType);
    res.status(response.status).send(bodyToSend);

    // Логи в консоль бэкенда при каждой генерации видео
    try {
      if (response.ok) {
        console.log('[video] create success', {
          id: data.id,
          model: data.model,
          status: data.status,
          progress: data.progress,
          size: data.size,
          seconds: data.seconds,
        });
      } else {
        console.log('[video] create error', {
          httpStatus: response.status,
          error: data.error,
          message: (data.error as { message?: string })?.message,
        });
      }
    } catch (_) {
      console.log('[video] create response (non-JSON)', { httpStatus: response.status, bodyLength: responseText?.length });
    }
  } catch (err) {
    console.error('AI proxy videos POST error:', err);
    if (err instanceof Error && err.message === 'FILE_TOO_LARGE') {
      res.status(413).json({ error: { message: 'Файл слишком большой' } });
      return;
    }
    const isTimeout = err instanceof Error && err.name === 'AbortError';
    res.status(isTimeout ? 504 : 500).json({
      error: { message: isTimeout ? 'Video creation request timed out' : 'Proxy request failed' },
    });
  }
});

// GET /api/ai/videos/:id — proxy video status (AITunnel)
router.get('/videos/:id', aiVideoStatusLimiter, async (req: AuthenticatedRequest, res: ExpressResponse) => {
  try {
    const apiKey = process.env.AITUNNEL_API_KEY;
    if (!apiKey) {
      res.status(500).json({ error: { message: 'AITUNNEL_API_KEY is not configured' } });
      return;
    }

    const { id } = req.params;
    const withPrefix = id.startsWith('video_') ? id : `video_${id}`;
    const withoutPrefix = id.startsWith('video_') ? id.slice('video_'.length) : id;

    let apiVideoId = withPrefix;
    let response = await fetchWithTimeout(`${AITUNNEL_BASE}/videos/${apiVideoId}`, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${apiKey}` },
      timeoutMs: VIDEO_TIMEOUT_MS,
    });

    let text = await response.text();

    // AITunnel для некоторых моделей (например, wan2.6) может ожидать голый UUID без video_.
    // Если первый запрос вернул not found, пробуем альтернативный формат id.
    if (!response.ok && withoutPrefix !== withPrefix) {
      try {
        const errData = JSON.parse(text);
        if (errData.error?.message?.includes('not found')) {
          apiVideoId = withoutPrefix;
          response = await fetchWithTimeout(`${AITUNNEL_BASE}/videos/${apiVideoId}`, {
            method: 'GET',
            headers: { 'Authorization': `Bearer ${apiKey}` },
            timeoutMs: VIDEO_TIMEOUT_MS,
          });
          text = await response.text();
        }
      } catch {
        // keep first response
      }
    }

    try {
      const data = JSON.parse(text);
      res.status(response.status).json(data);
    } catch {
      res.status(response.status).contentType('application/json').send(text);
    }
  } catch (err) {
    console.error('AI proxy videos GET status error:', err);
    const isTimeout = err instanceof Error && err.name === 'AbortError';
    res.status(isTimeout ? 504 : 500).json({
      error: { message: isTimeout ? 'Video status request timed out' : 'Proxy request failed' },
    });
  }
});

// GET /api/ai/videos/:id/content — proxy video download (binary, AITunnel)
router.get('/videos/:id/content', aiVideoContentLimiter, async (req: AuthenticatedRequest, res: ExpressResponse) => {
  try {
    const apiKey = process.env.AITUNNEL_API_KEY;
    if (!apiKey) {
      res.status(500).json({ error: { message: 'AITUNNEL_API_KEY is not configured' } });
      return;
    }

    const { id } = req.params;
    const withPrefix = id.startsWith('video_') ? id : `video_${id}`;
    const withoutPrefix = id.startsWith('video_') ? id.slice('video_'.length) : id;

    let apiVideoId = withPrefix;
    let response = await fetchWithTimeout(`${AITUNNEL_BASE}/videos/${apiVideoId}/content`, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${apiKey}` },
      timeoutMs: VIDEO_CONTENT_TIMEOUT_MS,
    });

    if (!response.ok && withoutPrefix !== withPrefix) {
      apiVideoId = withoutPrefix;
      response = await fetchWithTimeout(`${AITUNNEL_BASE}/videos/${apiVideoId}/content`, {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${apiKey}` },
        timeoutMs: VIDEO_CONTENT_TIMEOUT_MS,
      });
    }

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      res.status(response.status).contentType('application/json').json({
        error: { message: errText || `Failed to download video: ${response.status}` },
      });
      return;
    }

    const contentType = response.headers.get('content-type');
    if (contentType) res.setHeader('Content-Type', contentType);
    res.status(response.status);
    if (response.body) {
      const reader = response.body.getReader();
      const pump = async () => {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(Buffer.from(value));
        }
        res.end();
      };
      await pump();
    } else {
      res.end();
    }
  } catch (err) {
    console.error('AI proxy videos content error:', err);
    const isTimeout = err instanceof Error && err.name === 'AbortError';
    res.status(isTimeout ? 504 : 500).json({
      error: { message: isTimeout ? 'Video download timed out' : 'Proxy request failed' },
    });
  }
});

export default router;
