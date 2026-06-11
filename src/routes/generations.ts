import { Router, Response } from 'express';
import { GenerationService } from '../services/generationService';
import { StorageService, GENERATED_IMAGES_BUCKET } from '../services/storageService';
import { PlanService } from '../services/planService';
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth';
import { AdminService } from '../services/adminService';

const router = Router();

// Public gallery: generations shared by users (no auth required). Query: limit, offset.
router.get('/public', async (req, res: Response) => {
  try {
    const limit = req.query.limit != null ? Math.min(100, Math.max(1, Number(req.query.limit))) : undefined;
    const offset = req.query.offset != null ? Math.max(0, Number(req.query.offset)) : undefined;
    const { imageGenerations, videoGenerations, error } = await GenerationService.getPublicGenerations(
      [limit, offset].some((x) => x !== undefined) ? { limit, offset } : undefined
    );
    if (error) {
      res.status(500).json({ error });
      return;
    }
    res.json({ imageGenerations, videoGenerations });
  } catch (error) {
    console.error('Error in GET /public:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// All routes below require authentication
router.use(authenticateToken);

// Image Generation Routes
// GET /api/generations/image - Get all user image generations
router.get('/image', async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!req.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const limit = req.query.limit != null ? Math.min(100, Math.max(1, Number(req.query.limit))) : undefined;
    const offset = req.query.offset != null ? Math.max(0, Number(req.query.offset)) : undefined;
    const opts = [limit, offset].some((x) => x !== undefined) ? { limit, offset } : undefined;
    const { generations, error } = await GenerationService.getUserImageGenerations(req.userId!, opts);

    if (error) {
      res.status(500).json({ error });
      return;
    }

    res.json({ generations });
  } catch (error) {
    console.error('Error in GET /image:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/generations/image - Create new image generation
router.post('/image', async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!req.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const { allowed, limit, current, error: limitError } = await PlanService.checkImageLimit(req.userId);
    if (limitError) {
      res.status(500).json({ error: limitError });
      return;
    }
    if (!allowed) {
      res.status(403).json({
        error: `Дневной лимит изображений (${limit}) исчерпан. Перейдите на Премиум для безлимитной генерации.`,
        code: 'IMAGE_LIMIT_EXCEEDED',
        limit,
        current,
      });
      return;
    }

    const {
      model,
      prompt,
      negativePrompt,
      quality,
      size,
      outputFormat,
      numImages,
      imageUrls,
      status,
      errorMessage,
    } = req.body;

    if (!model || !prompt) {
      res.status(400).json({ error: 'Model and prompt are required' });
      return;
    }

    if (!(await PlanService.isModelGloballyEnabled(model))) {
      res.status(403).json({
        error: 'Эта модель отключена администратором.',
        code: 'MODEL_DISABLED',
      });
      return;
    }

    const { generation, error } = await GenerationService.createImageGeneration(req.userId, {
      model,
      prompt,
      negativePrompt,
      quality,
      size,
      outputFormat,
      numImages,
      imageUrls,
      status,
      errorMessage,
    });

    if (error || !generation) {
      res.status(500).json({ error: error || 'Failed to create image generation' });
      return;
    }

    // Log activity
    const ipAddress = req.ip || req.headers['x-forwarded-for'] as string || req.socket.remoteAddress;
    const userAgent = req.headers['user-agent'];
    await AdminService.logActivity(
      req.userId!,
      'image_generation_created',
      { generationId: generation.id, model, prompt: prompt.substring(0, 100), quality, size, numImages },
      ipAddress,
      userAgent
    );

    res.status(201).json({ generation });
  } catch (error) {
    console.error('Error in POST /image:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/generations/image/:id - Update image generation
router.put('/image/:id', async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!req.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const { id } = req.params;
    const { imageUrls, status, errorMessage, isPublic } = req.body;

    const { error } = await GenerationService.updateImageGeneration(id, req.userId, {
      imageUrls,
      status,
      errorMessage,
      isPublic: typeof isPublic === 'boolean' ? isPublic : undefined,
    });

    if (error) {
      res.status(500).json({ error });
      return;
    }

    // Log activity if status changed to completed
    if (status === 'completed') {
      const ipAddress = req.ip || req.headers['x-forwarded-for'] as string || req.socket.remoteAddress;
      const userAgent = req.headers['user-agent'];
      await AdminService.logActivity(
        req.userId!,
        'image_generation_completed',
        { generationId: id, imageCount: imageUrls?.length || 0 },
        ipAddress,
        userAgent
      );
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Error in PUT /image/:id:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

function extFromMime(mime: string): string {
  const m = (mime.split(';')[0] || '').trim().toLowerCase();
  if (m === 'image/png') return 'png';
  if (m === 'image/jpeg' || m === 'image/jpg') return 'jpg';
  if (m === 'image/webp') return 'webp';
  if (m === 'image/gif') return 'gif';
  return 'png';
}

async function bufferFromImageSource(src: string): Promise<{ buffer: Buffer; contentType: string; ext: string }> {
  const trimmed = src.trim();
  if (trimmed.startsWith('data:')) {
    const match = trimmed.match(/^data:([^;,]+)(;charset=[^;,]+)?;base64,(.+)$/i);
    if (!match) {
      throw new Error('Некорректный data URL изображения');
    }
    const mime = (match[1] || 'image/png').trim();
    const b64 = match[3] || '';
    const buffer = Buffer.from(b64, 'base64');
    return { buffer, contentType: mime, ext: extFromMime(mime) };
  }
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 120_000);
    try {
      const res = await fetch(trimmed, { signal: ac.signal });
      if (!res.ok) {
        throw new Error(`Скачивание изображения: HTTP ${res.status}`);
      }
      const buffer = Buffer.from(await res.arrayBuffer());
      const ct = res.headers.get('content-type')?.split(';')[0]?.trim() || 'image/png';
      return { buffer, contentType: ct, ext: extFromMime(ct) };
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error('Неподдерживаемый источник изображения');
}

function isAlreadyInGeneratedImagesBucket(url: string): boolean {
  return /^https?:\/\//i.test(url) && url.includes(`/${GENERATED_IMAGES_BUCKET}/`);
}

// POST /api/generations/image/:id/upload — положить сырые data URL / внешние URL в Storage, вернуть публичные URL
router.post('/image/:id/upload', async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!req.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const { id } = req.params;
    const sources = (req.body as { sources?: unknown }).sources;
    if (!Array.isArray(sources) || sources.length === 0) {
      res.status(400).json({ error: 'sources (массив строк) обязателен' });
      return;
    }
    if (sources.length > 16) {
      res.status(400).json({ error: 'Слишком много изображений за один запрос' });
      return;
    }

    const owns = await GenerationService.userOwnsImageGeneration(id, req.userId);
    if (!owns) {
      res.status(404).json({ error: 'Генерация не найдена' });
      return;
    }

    const urls: string[] = [];
    for (const s of sources) {
      if (typeof s !== 'string') {
        res.status(400).json({ error: 'Каждый элемент sources должен быть строкой' });
        return;
      }
      if (isAlreadyInGeneratedImagesBucket(s)) {
        urls.push(s);
        continue;
      }
      try {
        const { buffer, contentType, ext } = await bufferFromImageSource(s);
        const { url, error } = await StorageService.uploadGeneratedImage(req.userId, id, buffer, contentType, ext);
        if (error || !url) {
          res.status(500).json({ error: error || 'Не удалось загрузить в Storage' });
          return;
        }
        urls.push(url);
      } catch (e) {
        res.status(400).json({ error: e instanceof Error ? e.message : 'Некорректные данные изображения' });
        return;
      }
    }

    res.json({ urls });
  } catch (error) {
    console.error('Error in POST /image/:id/upload:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/generations/image/:id - Delete image generation (own only)
router.delete('/image/:id', async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!req.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const { id } = req.params;
    const { error } = await GenerationService.deleteImageGeneration(id, req.userId);
    if (error) {
      res.status(500).json({ error });
      return;
    }
    res.json({ success: true });
  } catch (error) {
    console.error('Error in DELETE /image/:id:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Video Generation Routes
// GET /api/generations/video - Get all user video generations
router.get('/video', async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!req.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const limit = req.query.limit != null ? Math.min(100, Math.max(1, Number(req.query.limit))) : undefined;
    const offset = req.query.offset != null ? Math.max(0, Number(req.query.offset)) : undefined;
    const opts = [limit, offset].some((x) => x !== undefined) ? { limit, offset } : undefined;
    const { generations, error } = await GenerationService.getUserVideoGenerations(req.userId!, opts);

    if (error) {
      res.status(500).json({ error });
      return;
    }

    res.json({ generations });
  } catch (error) {
    console.error('Error in GET /video:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/generations/video - Create new video generation
router.post('/video', async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!req.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const { allowed, limit, current, error: limitError } = await PlanService.checkVideoLimit(req.userId);
    if (limitError) {
      res.status(500).json({ error: limitError });
      return;
    }
    if (!allowed) {
      res.status(403).json({
        error: `Дневной лимит видео (${limit}) исчерпан. Перейдите на Премиум для безлимитной генерации.`,
        code: 'VIDEO_LIMIT_EXCEEDED',
        limit,
        current,
      });
      return;
    }

    const {
      model,
      prompt,
      negativePrompt,
      videoId,
      videoUrl,
      status,
      errorMessage,
      aspectRatio,
      duration,
      quality,
      motionMode,
      style,
      cameraMovement,
      seed,
      waterMark,
      size,
      seconds,
    } = req.body;

    if (!model || !prompt) {
      res.status(400).json({ error: 'Model and prompt are required' });
      return;
    }

    if (!(await PlanService.isModelGloballyEnabled(model))) {
      res.status(403).json({
        error: 'Эта модель отключена администратором.',
        code: 'MODEL_DISABLED',
      });
      return;
    }

    const { generation, error } = await GenerationService.createVideoGeneration(req.userId, {
      model,
      prompt,
      negativePrompt,
      videoId,
      videoUrl,
      status,
      errorMessage,
      aspectRatio,
      duration,
      quality,
      motionMode,
      style,
      cameraMovement,
      seed,
      waterMark,
      size,
      seconds,
    });

    if (error || !generation) {
      res.status(500).json({ error: error || 'Failed to create video generation' });
      return;
    }

    // Log activity
    const ipAddress = req.ip || req.headers['x-forwarded-for'] as string || req.socket.remoteAddress;
    const userAgent = req.headers['user-agent'];
    await AdminService.logActivity(
      req.userId!,
      'video_generation_created',
      { generationId: generation.id, model, prompt: prompt.substring(0, 100), duration, quality, aspectRatio },
      ipAddress,
      userAgent
    );

    res.status(201).json({ generation });
  } catch (error) {
    console.error('Error in POST /video:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/generations/video/:id - Update video generation
router.put('/video/:id', async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!req.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const { id } = req.params;
    const { videoId, videoUrl, status, errorMessage, isPublic } = req.body;

    const { error } = await GenerationService.updateVideoGeneration(id, req.userId, {
      videoId,
      videoUrl,
      status,
      errorMessage,
      isPublic: typeof isPublic === 'boolean' ? isPublic : undefined,
    });

    if (error) {
      res.status(500).json({ error });
      return;
    }

    // Log activity if status changed to completed
    if (status === 'completed') {
      const ipAddress = req.ip || req.headers['x-forwarded-for'] as string || req.socket.remoteAddress;
      const userAgent = req.headers['user-agent'];
      await AdminService.logActivity(
        req.userId!,
        'video_generation_completed',
        { generationId: id, videoUrl: videoUrl ? 'uploaded' : null },
        ipAddress,
        userAgent
      );
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Error in PUT /video/:id:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/generations/video/:id - Delete video generation (own only)
router.delete('/video/:id', async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!req.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const { id } = req.params;
    const { error } = await GenerationService.deleteVideoGeneration(id, req.userId);
    if (error) {
      res.status(500).json({ error });
      return;
    }
    res.json({ success: true });
  } catch (error) {
    console.error('Error in DELETE /video/:id:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/generations/video/:id/upload - Upload video to Supabase Storage
router.post('/video/:id/upload', async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!req.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const { id } = req.params;
    const { videoUrl, videoId, isAITunnel } = req.body;

    // Get the generation to verify ownership
    const { generations, error: fetchError } = await GenerationService.getUserVideoGenerations(req.userId);
    if (fetchError) {
      res.status(500).json({ error: fetchError });
      return;
    }

    const generation = generations.find(g => g.id === id);
    if (!generation) {
      res.status(404).json({ error: 'Video generation not found' });
      return;
    }

    let supabaseUrl: string;
    let uploadError: string | null = null;

    if (isAITunnel && videoId) {
      // Download from AITunnel and upload to Supabase (key from server env)
      const aitunnelKey = process.env.AITUNNEL_API_KEY;
      if (!aitunnelKey) {
        res.status(500).json({ error: 'AITUNNEL_API_KEY is not configured on server' });
        return;
      }
      const result = await StorageService.downloadAITunnelVideoAndUpload(
        videoId,
        aitunnelKey,
        req.userId,
        id
      );
      supabaseUrl = result.url;
      uploadError = result.error;
    } else if (videoUrl) {
      // Download from external URL and upload to Supabase
      const result = await StorageService.downloadAndUploadVideo(
        videoUrl,
        req.userId,
        id
      );
      supabaseUrl = result.url;
      uploadError = result.error;
    } else {
      res.status(400).json({ error: 'videoUrl or (videoId and isAITunnel for AITunnel) is required' });
      return;
    }

    if (uploadError || !supabaseUrl) {
      res.status(500).json({ error: uploadError || 'Failed to upload video to Supabase' });
      return;
    }

    // Update generation with Supabase URL
    const { error: updateError } = await GenerationService.updateVideoGeneration(id, req.userId, {
      videoUrl: supabaseUrl,
    });

    if (updateError) {
      res.status(500).json({ error: updateError });
      return;
    }

    // Log activity
    const ipAddress = req.ip || req.headers['x-forwarded-for'] as string || req.socket.remoteAddress;
    const userAgent = req.headers['user-agent'];
    await AdminService.logActivity(
      req.userId!,
      'video_uploaded_to_storage',
      { generationId: id, storageUrl: supabaseUrl },
      ipAddress,
      userAgent
    );

    res.json({ success: true, videoUrl: supabaseUrl });
  } catch (error) {
    console.error('Error in POST /video/:id/upload:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/generations/video/:id/video - Get signed URL for video playback (avoids 400 on public URL)
router.get('/video/:id/video', async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!req.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const { id } = req.params;
    let { generation, error: fetchError } = await GenerationService.getVideoGenerationById(id, req.userId);

    if (fetchError) {
      res.status(500).json({ error: fetchError });
      return;
    }
    // Чужие ролики из Creative Lab (is_public): владелец совпадает с записью в БД, зритель — нет.
    // Без этого шага подписанный URL выдаётся только автору, и у другого пользователя видео не играет.
    if (!generation) {
      const pub = await GenerationService.getVideoGenerationById(id);
      if (pub.error) {
        res.status(500).json({ error: pub.error });
        return;
      }
      if (pub.generation?.isPublic) {
        generation = pub.generation;
      }
    }
    if (!generation) {
      res.status(404).json({ error: 'Video generation not found' });
      return;
    }
    if (!generation.videoUrl) {
      res.status(404).json({ error: 'Video not yet available' });
      return;
    }

    const filePath = `${generation.userId}/${id}.mp4`;
    const { url: signedUrl, error: signError } = await StorageService.createSignedVideoUrl(filePath, 3600);

    if (signError || !signedUrl) {
      res.status(500).json({ error: signError || 'Failed to create playback URL' });
      return;
    }

    res.json({ url: signedUrl });
  } catch (error) {
    console.error('Error in GET /video/:id/video:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;

