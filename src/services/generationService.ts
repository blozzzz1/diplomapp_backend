import { randomUUID } from 'crypto';
import { supabaseAdmin } from '../config/supabase';
import { StorageService } from './storageService';

const SUPABASE_RETRY_ATTEMPTS = 3;
const SUPABASE_RETRY_DELAY_MS = 500;

function isTransientSupabaseError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  const code = err && typeof err === 'object' && 'code' in err ? String((err as any).code) : '';
  return (
    code === 'ECONNRESET' ||
    code === 'ETIMEDOUT' ||
    code === 'ECONNREFUSED' ||
    msg.includes('terminated') ||
    msg.includes('ECONNRESET') ||
    msg.includes('ETIMEDOUT')
  );
}

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < SUPABASE_RETRY_ATTEMPTS; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (i < SUPABASE_RETRY_ATTEMPTS - 1 && isTransientSupabaseError(e)) {
        await new Promise((r) => setTimeout(r, SUPABASE_RETRY_DELAY_MS));
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

export interface ImageGeneration {
  id: string;
  userId: string;
  model: string;
  prompt: string;
  negativePrompt?: string;
  quality?: string;
  size?: string;
  outputFormat?: string;
  numImages?: number;
  imageUrls: string[];
  status: 'pending' | 'processing' | 'completed' | 'failed';
  errorMessage?: string;
  isPublic?: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface VideoGeneration {
  id: string;
  userId: string;
  model: string;
  prompt: string;
  negativePrompt?: string;
  videoId?: string;
  videoUrl?: string;
  status: 'pending' | 'processing' | 'completed' | 'failed' | 'moderation_failed';
  errorMessage?: string;
  aspectRatio?: string;
  duration?: number;
  quality?: string;
  motionMode?: string;
  style?: string;
  cameraMovement?: string;
  seed?: number;
  waterMark?: boolean;
  size?: string;
  seconds?: number;
  isPublic?: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface DatabaseImageGeneration {
  id: string;
  user_id: string;
  model: string;
  prompt: string;
  negative_prompt?: string;
  quality?: string;
  size?: string;
  output_format?: string;
  num_images?: number;
  image_urls: string | any;
  status: string;
  error_message?: string;
  is_public?: boolean;
  created_at: string;
  updated_at: string;
}

export interface DatabaseVideoGeneration {
  id: string;
  user_id: string;
  model: string;
  prompt: string;
  negative_prompt?: string;
  video_id?: string;
  video_url?: string;
  status: string;
  error_message?: string;
  aspect_ratio?: string;
  duration?: number;
  quality?: string;
  motion_mode?: string;
  style?: string;
  camera_movement?: string;
  seed?: number;
  water_mark?: boolean;
  size?: string;
  seconds?: number;
  is_public?: boolean;
  created_at: string;
  updated_at: string;
}

export class GenerationService {
  // Image Generation Methods
  static async createImageGeneration(
    userId: string,
    params: {
      model: string;
      prompt: string;
      negativePrompt?: string;
      quality?: string;
      size?: string;
      outputFormat?: string;
      numImages?: number;
      imageUrls?: string[];
      status?: 'pending' | 'processing' | 'completed' | 'failed';
      errorMessage?: string;
    }
  ): Promise<{ generation: ImageGeneration | null; error: string | null }> {
    try {
      const id = randomUUID();
      const imageUrls = params.imageUrls || [];
      
      const { data, error } = await supabaseAdmin.rpc('create_image_generation', {
        p_id: id,
        p_user_id: userId,
        p_model: params.model,
        p_prompt: params.prompt,
        p_negative_prompt: params.negativePrompt || null,
        p_quality: params.quality || null,
        p_size: params.size || null,
        p_output_format: params.outputFormat || null,
        p_num_images: params.numImages || 1,
        p_image_urls: JSON.stringify(imageUrls),
        p_status: params.status || 'completed',
        p_error_message: params.errorMessage || null,
      });

      if (error) {
        // Fallback to direct insert
        const { error: insertError } = await supabaseAdmin
          .from('image_generations')
          .insert({
            id,
            user_id: userId,
            model: params.model,
            prompt: params.prompt,
            negative_prompt: params.negativePrompt,
            quality: params.quality,
            size: params.size,
            output_format: params.outputFormat,
            num_images: params.numImages || 1,
            image_urls: JSON.stringify(imageUrls),
            status: params.status || 'completed',
            error_message: params.errorMessage,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          });

        if (insertError) {
          console.error('Error creating image generation:', insertError);
          return { generation: null, error: insertError.message };
        }

        const generation: ImageGeneration = {
          id,
          userId,
          model: params.model,
          prompt: params.prompt,
          negativePrompt: params.negativePrompt,
          quality: params.quality,
          size: params.size,
          outputFormat: params.outputFormat,
          numImages: params.numImages || 1,
          imageUrls,
          status: params.status || 'completed',
          errorMessage: params.errorMessage,
          isPublic: false,
          createdAt: new Date(),
          updatedAt: new Date(),
        };

        return { generation, error: null };
      }

      if (data && (Array.isArray(data) ? data.length > 0 : data)) {
        const row = Array.isArray(data) ? data[0] : data;
        const generation: ImageGeneration = {
          id: row.id,
          userId: row.user_id,
          model: row.model,
          prompt: row.prompt,
          negativePrompt: row.negative_prompt,
          quality: row.quality,
          size: row.size,
          outputFormat: row.output_format,
          numImages: row.num_images,
          imageUrls: Array.isArray(row.image_urls) ? row.image_urls : (typeof row.image_urls === 'string' ? JSON.parse(row.image_urls) : []),
          status: row.status as ImageGeneration['status'],
          errorMessage: row.error_message,
          isPublic: row.is_public ?? false,
          createdAt: new Date(row.created_at),
          updatedAt: new Date(row.updated_at),
        };
        return { generation, error: null };
      }

      return { generation: null, error: 'Failed to create image generation' };
    } catch (error) {
      console.error('Error creating image generation:', error);
      return { generation: null, error: 'An unexpected error occurred' };
    }
  }

  static async updateImageGeneration(
    id: string,
    userId: string,
    params: {
      imageUrls?: string[];
      status?: 'pending' | 'processing' | 'completed' | 'failed';
      errorMessage?: string;
      isPublic?: boolean;
    }
  ): Promise<{ error: string | null }> {
    try {
      const { error } = await supabaseAdmin.rpc('update_image_generation', {
        p_id: id,
        p_user_id: userId,
        p_image_urls: params.imageUrls ? JSON.stringify(params.imageUrls) : null,
        p_status: params.status || null,
        p_error_message: params.errorMessage || null,
        p_is_public: params.isPublic ?? undefined,
      });

      if (error) {
        // Fallback to direct update
        const updateData: any = {
          updated_at: new Date().toISOString(),
        };

        if (params.imageUrls !== undefined) {
          updateData.image_urls = JSON.stringify(params.imageUrls);
        }
        if (params.status !== undefined) {
          updateData.status = params.status;
        }
        if (params.errorMessage !== undefined) {
          updateData.error_message = params.errorMessage;
        }
        if (params.isPublic !== undefined) {
          updateData.is_public = params.isPublic;
        }

        const { error: updateError } = await supabaseAdmin
          .from('image_generations')
          .update(updateData)
          .eq('id', id)
          .eq('user_id', userId);

        if (updateError) {
          console.error('Error updating image generation:', updateError);
          return { error: updateError.message };
        }
      }

      return { error: null };
    } catch (error) {
      console.error('Error updating image generation:', error);
      return { error: 'An unexpected error occurred' };
    }
  }

  static async userOwnsImageGeneration(id: string, userId: string): Promise<boolean> {
    const { data } = await supabaseAdmin
      .from('image_generations')
      .select('id')
      .eq('id', id)
      .eq('user_id', userId)
      .maybeSingle();
    return !!data;
  }

  /** Список генераций пользователя (по умолчанию limit 50 для быстрой первой загрузки). */
  static async getUserImageGenerations(
    userId: string,
    opts?: { limit?: number; offset?: number }
  ): Promise<{ generations: ImageGeneration[]; error: string | null }> {
    const limit = Math.min(Math.max(1, opts?.limit ?? 50), 100);
    const offset = Math.max(0, opts?.offset ?? 0);
    try {
      const { data, error } = await withRetry(async () =>
        supabaseAdmin
          .from('image_generations')
          .select('*')
          .eq('user_id', userId)
          .order('created_at', { ascending: false })
          .range(offset, offset + limit - 1)
      );

      if (error) {
        console.error('Error fetching image generations:', error);
        return { generations: [], error: error.message };
      }

      const generations: ImageGeneration[] = (data || []).map((row: DatabaseImageGeneration) => ({
        id: row.id,
        userId: row.user_id,
        model: row.model,
        prompt: row.prompt,
        negativePrompt: row.negative_prompt,
        quality: row.quality,
        size: row.size,
        outputFormat: row.output_format,
        numImages: row.num_images || 1,
        imageUrls: Array.isArray(row.image_urls) ? row.image_urls : (typeof row.image_urls === 'string' ? JSON.parse(row.image_urls) : []),
        status: row.status as ImageGeneration['status'],
        errorMessage: row.error_message,
        isPublic: row.is_public ?? false,
        createdAt: new Date(row.created_at),
        updatedAt: new Date(row.updated_at),
      }));

      return { generations, error: null };
    } catch (error) {
      console.error('Error fetching image generations:', error);
      return { generations: [], error: 'An unexpected error occurred' };
    }
  }

  // Video Generation Methods
  static async createVideoGeneration(
    userId: string,
    params: {
      model: string;
      prompt: string;
      negativePrompt?: string;
      videoId?: string;
      videoUrl?: string;
      status?: 'pending' | 'processing' | 'completed' | 'failed' | 'moderation_failed';
      errorMessage?: string;
      aspectRatio?: string;
      duration?: number;
      quality?: string;
      motionMode?: string;
      style?: string;
      cameraMovement?: string;
      seed?: number;
      waterMark?: boolean;
      size?: string;
      seconds?: number;
    }
  ): Promise<{ generation: VideoGeneration | null; error: string | null }> {
    try {
      const id = randomUUID();
      
      const { data, error } = await supabaseAdmin.rpc('create_video_generation', {
        p_id: id,
        p_user_id: userId,
        p_model: params.model,
        p_prompt: params.prompt,
        p_negative_prompt: params.negativePrompt || null,
        p_video_id: params.videoId || null,
        p_video_url: params.videoUrl || null,
        p_status: params.status || 'pending',
        p_error_message: params.errorMessage || null,
        p_aspect_ratio: params.aspectRatio || null,
        p_duration: params.duration || null,
        p_quality: params.quality || null,
        p_motion_mode: params.motionMode || null,
        p_style: params.style || null,
        p_camera_movement: params.cameraMovement || null,
        p_seed: params.seed || null,
        p_water_mark: params.waterMark || false,
        p_size: params.size || null,
        p_seconds: params.seconds || null,
      });

      if (error) {
        // Fallback to direct insert
        const { error: insertError } = await supabaseAdmin
          .from('video_generations')
          .insert({
            id,
            user_id: userId,
            model: params.model,
            prompt: params.prompt,
            negative_prompt: params.negativePrompt,
            video_id: params.videoId,
            video_url: params.videoUrl,
            status: params.status || 'pending',
            error_message: params.errorMessage,
            aspect_ratio: params.aspectRatio,
            duration: params.duration,
            quality: params.quality,
            motion_mode: params.motionMode,
            style: params.style,
            camera_movement: params.cameraMovement,
            seed: params.seed,
            water_mark: params.waterMark || false,
            size: params.size,
            seconds: params.seconds,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          });

        if (insertError) {
          console.error('Error creating video generation:', insertError);
          return { generation: null, error: insertError.message };
        }

        const generation: VideoGeneration = {
          id,
          userId,
          model: params.model,
          prompt: params.prompt,
          negativePrompt: params.negativePrompt,
          videoId: params.videoId,
          videoUrl: params.videoUrl,
          status: params.status || 'pending',
          errorMessage: params.errorMessage,
          aspectRatio: params.aspectRatio,
          duration: params.duration,
          quality: params.quality,
          motionMode: params.motionMode,
          style: params.style,
          cameraMovement: params.cameraMovement,
          seed: params.seed,
          waterMark: params.waterMark,
          size: params.size,
          seconds: params.seconds,
          createdAt: new Date(),
          updatedAt: new Date(),
        };

        return { generation, error: null };
      }

      if (data && (Array.isArray(data) ? data.length > 0 : data)) {
        const row = Array.isArray(data) ? data[0] : data;
        const generation: VideoGeneration = {
          id: row.id,
          userId: row.user_id,
          model: row.model,
          prompt: row.prompt,
          negativePrompt: row.negative_prompt,
          videoId: row.video_id,
          videoUrl: row.video_url,
          status: row.status as VideoGeneration['status'],
          errorMessage: row.error_message,
          aspectRatio: row.aspect_ratio,
          duration: row.duration,
          quality: row.quality,
          motionMode: row.motion_mode,
          style: row.style,
          cameraMovement: row.camera_movement,
          seed: row.seed,
          waterMark: row.water_mark,
          size: row.size,
          seconds: row.seconds,
          isPublic: row.is_public ?? false,
          createdAt: new Date(row.created_at),
          updatedAt: new Date(row.updated_at),
        };
        return { generation, error: null };
      }

      return { generation: null, error: 'Failed to create video generation' };
    } catch (error) {
      console.error('Error creating video generation:', error);
      return { generation: null, error: 'An unexpected error occurred' };
    }
  }

  static async updateVideoGeneration(
    id: string,
    userId: string,
    params: {
      videoId?: string;
      videoUrl?: string;
      status?: 'pending' | 'processing' | 'completed' | 'failed' | 'moderation_failed';
      errorMessage?: string;
      isPublic?: boolean;
    }
  ): Promise<{ error: string | null }> {
    try {
      const { error } = await supabaseAdmin.rpc('update_video_generation', {
        p_id: id,
        p_user_id: userId,
        p_video_id: params.videoId || null,
        p_video_url: params.videoUrl || null,
        p_status: params.status || null,
        p_error_message: params.errorMessage || null,
        p_is_public: params.isPublic ?? undefined,
      });

      if (error) {
        // Fallback to direct update
        const updateData: any = {
          updated_at: new Date().toISOString(),
        };

        if (params.videoId !== undefined) {
          updateData.video_id = params.videoId;
        }
        if (params.videoUrl !== undefined) {
          updateData.video_url = params.videoUrl;
        }
        if (params.status !== undefined) {
          updateData.status = params.status;
        }
        if (params.errorMessage !== undefined) {
          updateData.error_message = params.errorMessage;
        }
        if (params.isPublic !== undefined) {
          updateData.is_public = params.isPublic;
        }

        const { error: updateError } = await supabaseAdmin
          .from('video_generations')
          .update(updateData)
          .eq('id', id)
          .eq('user_id', userId);

        if (updateError) {
          console.error('Error updating video generation:', updateError);
          return { error: updateError.message };
        }
      }

      return { error: null };
    } catch (error) {
      console.error('Error updating video generation:', error);
      return { error: 'An unexpected error occurred' };
    }
  }

  /** Удалить генерацию изображения (только свою). */
  static async deleteImageGeneration(id: string, userId: string): Promise<{ error: string | null }> {
    try {
      const { error } = await withRetry(async () =>
        supabaseAdmin.from('image_generations').delete().eq('id', id).eq('user_id', userId)
      );
      if (error) {
        console.error('Error deleting image generation:', error);
        return { error: error.message };
      }
      return { error: null };
    } catch (err) {
      console.error('Error deleting image generation:', err);
      return { error: err instanceof Error ? err.message : 'An unexpected error occurred' };
    }
  }

  /** Удалить генерацию видео (только свою) и файл в bucket при наличии. */
  static async deleteVideoGeneration(id: string, userId: string): Promise<{ error: string | null }> {
    try {
      const { error: delError } = await withRetry(async () =>
        supabaseAdmin.from('video_generations').delete().eq('id', id).eq('user_id', userId)
      );
      if (delError) {
        console.error('Error deleting video generation:', delError);
        return { error: delError.message };
      }
      const { error: storageError } = await StorageService.deleteVideo(userId, id);
      if (storageError) {
        console.warn('Video generation row deleted but storage cleanup failed:', storageError);
      }
      return { error: null };
    } catch (err) {
      console.error('Error deleting video generation:', err);
      return { error: err instanceof Error ? err.message : 'An unexpected error occurred' };
    }
  }

  /** Список генераций пользователя (по умолчанию limit 50). */
  static async getUserVideoGenerations(
    userId: string,
    opts?: { limit?: number; offset?: number }
  ): Promise<{ generations: VideoGeneration[]; error: string | null }> {
    const limit = Math.min(Math.max(1, opts?.limit ?? 50), 100);
    const offset = Math.max(0, opts?.offset ?? 0);
    try {
      const { data, error } = await withRetry(async () =>
        supabaseAdmin
          .from('video_generations')
          .select('*')
          .eq('user_id', userId)
          .order('created_at', { ascending: false })
          .range(offset, offset + limit - 1)
      );

      if (error) {
        console.error('Error fetching video generations:', error);
        return { generations: [], error: error.message };
      }

      const generations: VideoGeneration[] = (data || []).map((row: DatabaseVideoGeneration) => ({
        id: row.id,
        userId: row.user_id,
        model: row.model,
        prompt: row.prompt,
        negativePrompt: row.negative_prompt,
        videoId: row.video_id,
        videoUrl: row.video_url,
        status: row.status as VideoGeneration['status'],
        errorMessage: row.error_message,
        aspectRatio: row.aspect_ratio,
        duration: row.duration,
        quality: row.quality,
        motionMode: row.motion_mode,
        style: row.style,
        cameraMovement: row.camera_movement,
        seed: row.seed,
        waterMark: row.water_mark,
        size: row.size,
        seconds: row.seconds,
        isPublic: row.is_public ?? false,
        createdAt: new Date(row.created_at),
        updatedAt: new Date(row.updated_at),
      }));

      return { generations, error: null };
    } catch (error) {
      console.error('Error fetching video generations:', error);
      return { generations: [], error: 'An unexpected error occurred' };
    }
  }

  /** Get a single video generation by id; optional userId to ensure ownership. */
  static async getVideoGenerationById(
    id: string,
    userId?: string
  ): Promise<{ generation: VideoGeneration | null; error: string | null }> {
    try {
      let query = supabaseAdmin.from('video_generations').select('*').eq('id', id);
      if (userId) {
        query = query.eq('user_id', userId);
      }
      const { data, error } = await query.maybeSingle();

      if (error) {
        console.error('Error fetching video generation:', error);
        return { generation: null, error: error.message };
      }
      if (!data) {
        return { generation: null, error: null };
      }

      const row = data as DatabaseVideoGeneration;
      const generation: VideoGeneration = {
        id: row.id,
        userId: row.user_id,
        model: row.model,
        prompt: row.prompt,
        negativePrompt: row.negative_prompt,
        videoId: row.video_id,
        videoUrl: row.video_url,
        status: row.status as VideoGeneration['status'],
        errorMessage: row.error_message,
        aspectRatio: row.aspect_ratio,
        duration: row.duration,
        quality: row.quality,
        motionMode: row.motion_mode,
        style: row.style,
        cameraMovement: row.camera_movement,
        seed: row.seed,
        waterMark: row.water_mark,
        size: row.size,
        seconds: row.seconds,
        isPublic: row.is_public ?? false,
        createdAt: new Date(row.created_at),
        updatedAt: new Date(row.updated_at),
      };
      return { generation, error: null };
    } catch (error) {
      console.error('Error in getVideoGenerationById:', error);
      return { generation: null, error: 'An unexpected error occurred' };
    }
  }

  /** Get public generations (for Creative Lab gallery). По умолчанию limit 24 для быстрой загрузки. */
  static async getPublicGenerations(opts?: { limit?: number; offset?: number }): Promise<{
    imageGenerations: ImageGeneration[];
    videoGenerations: VideoGeneration[];
    error: string | null;
  }> {
    const limit = Math.min(Math.max(1, opts?.limit ?? 24), 100);
    const offset = Math.max(0, opts?.offset ?? 0);
    try {
      const [imgRes, vidRes] = await withRetry(async () => {
        const [img, vid] = await Promise.all([
          supabaseAdmin
            .from('image_generations')
            .select('*')
            .eq('is_public', true)
            .order('created_at', { ascending: false })
            .range(offset, offset + limit - 1),
          supabaseAdmin
            .from('video_generations')
            .select('*')
            .eq('is_public', true)
            .order('created_at', { ascending: false })
            .range(offset, offset + limit - 1),
        ]);

        // Если Supabase вернул transient-ошибку через поле error, а не через throw — инициируем retry.
        if (img.error && isTransientSupabaseError(img.error)) {
          throw img.error;
        }
        if (vid.error && isTransientSupabaseError(vid.error)) {
          throw vid.error;
        }
        return [img, vid] as const;
      });

      if (imgRes.error) {
        console.error('Error fetching public image generations:', imgRes.error);
        return { imageGenerations: [], videoGenerations: [], error: imgRes.error.message };
      }
      if (vidRes.error) {
        console.error('Error fetching public video generations:', vidRes.error);
        return { imageGenerations: [], videoGenerations: [], error: vidRes.error.message };
      }

      const imageGenerations: ImageGeneration[] = (imgRes.data || []).map((row: DatabaseImageGeneration) => ({
        id: row.id,
        userId: row.user_id,
        model: row.model,
        prompt: row.prompt,
        negativePrompt: row.negative_prompt,
        quality: row.quality,
        size: row.size,
        outputFormat: row.output_format,
        numImages: row.num_images || 1,
        imageUrls: Array.isArray(row.image_urls) ? row.image_urls : (typeof row.image_urls === 'string' ? JSON.parse(row.image_urls) : []),
        status: row.status as ImageGeneration['status'],
        errorMessage: row.error_message,
        isPublic: true,
        createdAt: new Date(row.created_at),
        updatedAt: new Date(row.updated_at),
      }));

      const videoGenerations: VideoGeneration[] = (vidRes.data || []).map((row: DatabaseVideoGeneration) => ({
        id: row.id,
        userId: row.user_id,
        model: row.model,
        prompt: row.prompt,
        negativePrompt: row.negative_prompt,
        videoId: row.video_id,
        videoUrl: row.video_url,
        status: row.status as VideoGeneration['status'],
        errorMessage: row.error_message,
        aspectRatio: row.aspect_ratio,
        duration: row.duration,
        quality: row.quality,
        motionMode: row.motion_mode,
        style: row.style,
        cameraMovement: row.camera_movement,
        seed: row.seed,
        waterMark: row.water_mark,
        size: row.size,
        seconds: row.seconds,
        isPublic: true,
        createdAt: new Date(row.created_at),
        updatedAt: new Date(row.updated_at),
      }));

      return { imageGenerations, videoGenerations, error: null };
    } catch (error) {
      console.error('Error in getPublicGenerations:', error);
      return {
        imageGenerations: [],
        videoGenerations: [],
        error: error instanceof Error ? error.message : 'An unexpected error occurred',
      };
    }
  }
}

