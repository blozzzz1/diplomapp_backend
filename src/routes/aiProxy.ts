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

const CHAT_TIMEOUT_MS = 120000;   // 2 min — ответ модели может быть долгим
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

const INTELLIGENCE_CHAT_URL = 'https://api.intelligence.io.solutions/api/v1/chat/completions';
const AITUNNEL_BASE = 'https://api.aitunnel.ru/v1';
const AITUNNEL_CHAT_URL = `${AITUNNEL_BASE}/chat/completions`;

// Same list as frontend aiService.ts (каталог aitunnel.ru/models)
const AITUNNEL_MODELS = [
  'claude-sonnet-4.6', 'claude-fable-5', 'claude-opus-4.8', 'claude-opus-4.8-fast', 'claude-opus-4.7', 'claude-opus-4.6', 'claude-opus-4.5', 'claude-haiku-4.5', 'claude-sonnet-4.5',
  'claude-opus-4.1', 'claude-opus-4', 'claude-sonnet-4', 'claude-3.7-sonnet', 'claude-3.5-haiku', 'claude-3.5-sonnet',
  'grok-4', 'grok-4.1-fast', 'grok-4-fast', 'grok-code-fast-1', 'grok-4.20', 'grok-4.20-multi-agent', 'grok-build-0.1',
  'gemini-2.5-pro', 'gemini-2.5-flash', 'gemma-4-26b-a4b-it', 'gemma-4-31b-it', 'gemini-3.1-pro-preview',
  'gemini-3.1-pro-preview-customtools', 'gemini-3-flash-preview', 'gemini-3-pro-image-preview',
  'gemini-3.1-flash-image-preview',
  'gemini-3-pro-preview', 'gemini-2.5-flash-image', 'gemini-2.5-flash-lite-preview-09-2025', 'gemini-2.5-flash-lite',
  'gemini-3.1-flash-lite', 'gemini-3.5-flash',
  'gemini-2.0-flash-lite-001', 'gemini-2.0-flash-001',
  'sonar-pro-search', 'sonar-reasoning-pro', 'sonar-pro', 'sonar-deep-research', 'sonar', 'sonar-reasoning',
  'gpt-5.3-codex', 'gpt-5.2-chat', 'gpt-5.2-pro', 'gpt-5.2', 'gpt-5.2-codex', 'gpt-5.1-codex-max', 'gpt-5.1', 'gpt-5.1-chat',
  'gpt-5.1-codex', 'gpt-5.1-codex-mini', 'gpt-5-image', 'gpt-5-pro', 'gpt-5-codex', 'gpt-5-mini-2025-08-07',
  'gpt-4.1', 'gpt-4.1-mini', 'gpt-4.1-nano', 'gpt-4o-audio-preview', 'gpt-4o-mini-search-preview', 'gpt-4o-search-preview',
  'gpt-4o-2024-11-20', 'gpt-4o-2024-08-06', 'gpt-4o-mini-2024-07-18', 'gpt-4o-mini-audio-preview',
  'gpt-4-turbo', 'gpt-4', 'gpt-3.5-turbo', 'gpt-audio', 'gpt-audio-mini',
  'o3-pro', 'o3', 'o3-mini', 'o4-mini', 'o1-pro', 'o1', 'o1-mini',
  'glm-5', 'glm-5.1', 'glm-4.7-flash', 'glm-4.7', 'glm-4.6v', 'glm-4.5v', 'glm-4.5', 'glm-4.5-air', 'glm-4-32b',
  'qwen3.5-plus-02-15', 'qwen3.5-397b-a17b', 'qwen3-max-thinking', 'qwen3-coder-next', 'qwen3-max',
  'qwen3-coder-30b-a3b-instruct', 'qwen3-235b-a22b-2507', 'qwen3-30b-a3b',
  'minimax-m3', 'minimax-m2.5', 'minimax-m2-her', 'minimax-m2.1', 'minimax-m2', 'minimax-m1', 'minimax-01',
  'deepseek-v3.2-speciale', 'deepseek-v3.2-exp', 'deepseek-v3.1-terminus',
  'deepseek-chat-v3.1', 'deepseek-chat-v3-0324', 'deepseek-chat',
  'mistral-large-2512', 'mistral-medium-3.1', 'mistral-small-3.2-24b-instruct', 'codestral-2508',
  'kimi-k2.5', 'kimi-k2.6',
  'mimo-v2.5', 'mimo-v2.5-pro',
  'gpt-5.5', 'gpt-5.5-pro',
  'qwen3.6-27b', 'qwen3.6-max-preview', 'qwen3.7-max', 'qwen3.6-35b-a3b', 'qwen3.6-flash', 'qwen3.5-plus-20260420',
  'grok-4.3',
  'deepseek-v4-flash',
  'llama-3.2-1b-instruct', 'llama-3.2-3b-instruct', 'llama-3.2-11b-vision-instruct',
  'gigachat-2', 'gigachat-2-pro', 'gigachat-2-max',
];

function isAITunnelModel(model: string): boolean {
  return AITUNNEL_MODELS.includes(model);
}

/** Claude Fable 5 отклоняет temperature/top_p/top_k и часть reasoning-параметров (400 от провайдера). */
function isClaudeFableModel(model: string): boolean {
  const id = model.toLowerCase();
  return id === 'claude-fable-5' || id.startsWith('claude-fable');
}

function sanitizeAitunnelChatBody(body: Record<string, unknown>, model: string): Record<string, unknown> {
  const out = { ...body };
  if (!isClaudeFableModel(model)) {
    return out;
  }
  delete out.temperature;
  delete out.top_p;
  delete out.top_k;
  delete out.reasoning_effort;
  delete out.thinking;
  return out;
}

const router = Router();

router.use(authenticateToken);
router.use(aiGeneralLimiter);

// POST /api/ai/chat/completions — proxy chat (Intelligence or AITunnel)
router.post('/chat/completions', aiChatLimiter, async (req: AuthenticatedRequest, res: ExpressResponse) => {
  try {
    const body = await readJsonBody(req);
    const rawModel = body?.model;
    if (!rawModel || typeof rawModel !== 'string' || !rawModel.trim()) {
      res.status(400).json({ error: { message: 'Поле model обязательно' } });
      return;
    }
    const model = rawModel.trim();
    body.model = model;
    const { allowed, error: planErr } = await PlanService.canUseChatModel(req.userId!, model);
    if (!allowed) {
      if (planErr) {
        res.status(503).json({
          error: { message: 'Не удалось проверить тариф. Повторите позже.' },
        });
        return;
      }
      res.status(403).json({
        error: {
          message: 'Модель недоступна для вашего тарифа или отключена администратором.',
          code: 'MODEL_NOT_ALLOWED',
        },
      });
      return;
    }

    const aiKey = process.env.AI_API_KEY;
    const aitunnelKey = process.env.AITUNNEL_API_KEY;
    const useAITunnel = isAITunnelModel(model);
    const apiKey = useAITunnel ? aitunnelKey : aiKey;
    const apiUrl = useAITunnel ? AITUNNEL_CHAT_URL : INTELLIGENCE_CHAT_URL;

    if (!apiKey) {
      res.status(500).json({
        error: {
          message: useAITunnel ? 'AITUNNEL_API_KEY is not configured' : 'AI_API_KEY is not configured',
        },
      });
      return;
    }

    const payload = useAITunnel ? sanitizeAitunnelChatBody(body, model) : body;

    const response = await fetchWithTimeout(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify(payload),
      timeoutMs: CHAT_TIMEOUT_MS,
    });

    const text = await response.text();
    if (!response.ok) {
      console.error(`AI chat proxy ${response.status} (${model}):`, text.slice(0, 800));
    }
    try {
      const data = JSON.parse(text);
      res.status(response.status).json(data);
    } catch {
      res.status(response.status).contentType('application/json').send(text);
    }
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
