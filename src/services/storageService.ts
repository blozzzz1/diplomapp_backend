import { randomUUID } from 'crypto';
import { supabaseAdmin } from '../config/supabase';

const VIDEO_BUCKET_NAME = 'videos';
const CHAT_ATTACHMENTS_BUCKET = 'chatfiles';
export const GENERATED_IMAGES_BUCKET = 'generated-images';
const MAX_CHAT_ATTACHMENT_BYTES = 12 * 1024 * 1024;
/** Одно изображение после decode (генерация Creative Lab / AITUNNEL) */
const MAX_GENERATED_IMAGE_BYTES = 25 * 1024 * 1024;

export class StorageService {
  /**
   * Uploads a video file to Supabase Storage
   * @param videoBlob - The video file as a Blob or Buffer
   * @param userId - The user ID who owns the video
   * @param videoId - The video generation ID (for unique naming)
   * @returns The public URL of the uploaded video
   */
  static async uploadVideo(
    videoBlob: Blob | Buffer | ArrayBuffer,
    userId: string,
    videoId: string
  ): Promise<{ url: string; error: string | null }> {
    try {
      // Ensure bucket exists (create if not exists)
      const { data: buckets, error: bucketsError } = await supabaseAdmin.storage.listBuckets();
      
      if (bucketsError) {
        console.error('Error listing buckets:', bucketsError);
        return { url: '', error: `Failed to check buckets: ${bucketsError.message}` };
      }

      const bucketExists = buckets?.some(bucket => bucket.name === VIDEO_BUCKET_NAME);
      
      if (!bucketExists) {
        // Create bucket if it doesn't exist
        const { error: createError } = await supabaseAdmin.storage.createBucket(VIDEO_BUCKET_NAME, {
          public: true, // Make videos publicly accessible
          fileSizeLimit: 100 * 1024 * 1024, // 100MB limit
          allowedMimeTypes: ['video/mp4', 'video/webm', 'video/quicktime'],
        });

        if (createError) {
          console.error('Error creating bucket:', createError);
          return { url: '', error: `Failed to create bucket: ${createError.message}` };
        }
      }

      // Generate unique file path: videos/{userId}/{videoId}.mp4
      const filePath = `${userId}/${videoId}.mp4`;

      // Convert Blob to Buffer if needed (for Node.js compatibility)
      let videoBuffer: Buffer;
      if (Buffer.isBuffer(videoBlob)) {
        videoBuffer = videoBlob;
      } else if (videoBlob instanceof ArrayBuffer) {
        videoBuffer = Buffer.from(videoBlob);
      } else {
        // Blob - convert to Buffer (check if it's a Blob-like object)
        const blob = videoBlob as any;
        if (blob.arrayBuffer && typeof blob.arrayBuffer === 'function') {
          const arrayBuffer = await blob.arrayBuffer();
          videoBuffer = Buffer.from(arrayBuffer);
        } else if (blob.buffer) {
          videoBuffer = Buffer.from(blob.buffer);
        } else {
          return { url: '', error: 'Unsupported video blob type' };
        }
      }

      // Upload video
      const { data, error } = await supabaseAdmin.storage
        .from(VIDEO_BUCKET_NAME)
        .upload(filePath, videoBuffer, {
          contentType: 'video/mp4',
          upsert: true, // Overwrite if exists
        });

      if (error) {
        console.error('Error uploading video:', error);
        return { url: '', error: `Failed to upload video: ${error.message}` };
      }

      // Get public URL
      const { data: urlData } = supabaseAdmin.storage
        .from(VIDEO_BUCKET_NAME)
        .getPublicUrl(filePath);

      if (!urlData?.publicUrl) {
        return { url: '', error: 'Failed to get public URL' };
      }

      return { url: urlData.publicUrl, error: null };
    } catch (error) {
      console.error('Unexpected error in uploadVideo:', error);
      return {
        url: '',
        error: error instanceof Error ? error.message : 'Unexpected error occurred',
      };
    }
  }

  /**
   * Downloads a video from an external URL and uploads it to Supabase Storage
   * @param videoUrl - The external video URL
   * @param userId - The user ID who owns the video
   * @param videoId - The video generation ID (for unique naming)
   * @returns The public URL of the uploaded video
   */
  static async downloadAndUploadVideo(
    videoUrl: string,
    userId: string,
    videoId: string
  ): Promise<{ url: string; error: string | null }> {
    try {
      // Download video from external URL
      const response = await fetch(videoUrl);
      
      if (!response.ok) {
        return { url: '', error: `Failed to download video: ${response.status} ${response.statusText}` };
      }

      const videoBlob = await response.blob();
      
      // Upload to Supabase
      return await this.uploadVideo(videoBlob, userId, videoId);
    } catch (error) {
      console.error('Error in downloadAndUploadVideo:', error);
      return {
        url: '',
        error: error instanceof Error ? error.message : 'Failed to download and upload video',
      };
    }
  }

  /**
   * Downloads a video from AITunnel API (requires authentication) and uploads to Supabase
   * @param videoId - The AITunnel video ID
   * @param apiKey - The AITunnel API key
   * @param userId - The user ID who owns the video
   * @param generationId - The video generation ID (for unique naming)
   * @returns The public URL of the uploaded video
   */
  static async downloadAITunnelVideoAndUpload(
    videoId: string,
    apiKey: string,
    userId: string,
    generationId: string
  ): Promise<{ url: string; error: string | null }> {
    try {
      const trimmed = String(videoId || '').trim();
      if (!trimmed) {
        return { url: '', error: 'Missing AITunnel videoId' };
      }

      /** Варианты id для /videos и /content (WAN и др. то с префиксом video_, то без) */
      const idVariantsForContent = (raw: string): string[] => {
        if (raw.startsWith('video_')) {
          const bare = raw.slice('video_'.length);
          return bare ? [raw, bare] : [raw];
        }
        return [`video_${raw}`, raw];
      };

      const authHeaders = { Authorization: `Bearer ${apiKey}` };

      const pickIdsFromMeta = async (candidates: string[]): Promise<string[]> => {
        const seen = new Set<string>();
        const out: string[] = [];
        for (const c of candidates) {
          const meta = await fetch(`https://api.aitunnel.ru/v1/videos/${c}`, {
            method: 'GET',
            headers: authHeaders,
          });
          if (!meta.ok) continue;
          try {
            const j = (await meta.json()) as { id?: unknown };
            if (j?.id == null) continue;
            const canonical = String(j.id);
            for (const v of idVariantsForContent(canonical)) {
              if (!seen.has(v)) {
                seen.add(v);
                out.push(v);
              }
            }
          } catch {
            /* ignore */
          }
        }
        return out;
      };

      const tryDownloadOnce = async (): Promise<{ ok: true; blob: Blob } | { ok: false; status: number; text: string }> => {
        const base = idVariantsForContent(trimmed);
        const fromMeta = await pickIdsFromMeta(base);
        const tryOrder = [...new Set([...fromMeta, ...base])];

        let lastStatus = 0;
        let lastText = '';
        for (const tid of tryOrder) {
          const response = await fetch(`https://api.aitunnel.ru/v1/videos/${tid}/content`, {
            method: 'GET',
            headers: authHeaders,
          });
          if (response.ok) {
            const videoBlob = await response.blob();
            return { ok: true, blob: videoBlob };
          }
          lastStatus = response.status;
          lastText = await response.text().catch(() => '');
        }
        return { ok: false, status: lastStatus, text: lastText };
      };

      const maxAttempts = 4;
      const delayMs = 2500;

      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        if (attempt > 0) {
          await new Promise((r) => setTimeout(r, delayMs));
        }

        const result = await tryDownloadOnce();
        if (result.ok) {
          return await this.uploadVideo(result.blob, userId, generationId);
        }

        const retriable =
          result.status === 404 ||
          /not\s*found|not ready|ещё не готов|временно недоступно/i.test(result.text);
        if (!retriable) {
          return {
            url: '',
            error: `Failed to download from AITunnel: ${result.status} ${result.text}`,
          };
        }
      }

      return {
        url: '',
        error:
          `Failed to download from AITunnel after ${maxAttempts} attempts (видео не найдено на стороне AITunnel или ещё не готово к выдаче по /content).`,
      };
    } catch (error) {
      console.error('Error in downloadAITunnelVideoAndUpload:', error);
      return {
        url: '',
        error: error instanceof Error ? error.message : 'Failed to download and upload AITunnel video',
      };
    }
  }

  /**
   * Creates a signed URL for a video in Storage (works even when bucket public URL returns 400).
   * @param filePath - Path in bucket, e.g. "userId/videoId.mp4"
   * @param expiresInSeconds - URL validity in seconds (default 1 hour)
   */
  static async createSignedVideoUrl(
    filePath: string,
    expiresInSeconds: number = 3600
  ): Promise<{ url: string; error: string | null }> {
    try {
      const { data, error } = await supabaseAdmin.storage
        .from(VIDEO_BUCKET_NAME)
        .createSignedUrl(filePath, expiresInSeconds);

      if (error) {
        console.error('Error creating signed URL:', error);
        return { url: '', error: error.message };
      }
      if (!data?.signedUrl) {
        return { url: '', error: 'Failed to create signed URL' };
      }
      return { url: data.signedUrl, error: null };
    } catch (err) {
      console.error('Unexpected error in createSignedVideoUrl:', err);
      return {
        url: '',
        error: err instanceof Error ? err.message : 'Unexpected error',
      };
    }
  }

  /**
   * Deletes a video from Supabase Storage
   * @param userId - The user ID who owns the video
   * @param videoId - The video generation ID
   */
  /**
   * Загрузка вложения чата (картинка / PDF / др.) в публичный bucket — в БД хранится только URL.
   */
  static async uploadChatAttachment(
    fileBuffer: Buffer,
    userId: string,
    sessionId: string,
    uniqueId: string,
    contentType: string,
    filenameExt: string
  ): Promise<{ url: string; error: string | null }> {
    try {
      if (fileBuffer.length > MAX_CHAT_ATTACHMENT_BYTES) {
        return { url: '', error: 'Файл слишком большой для вложения в чат' };
      }

      const { data: buckets, error: buckets_error } = await supabaseAdmin.storage.listBuckets();
      if (buckets_error) {
        return { url: '', error: `Failed to check buckets: ${buckets_error.message}` };
      }

      const exists = buckets?.some((b) => b.name === CHAT_ATTACHMENTS_BUCKET);
      if (!exists) {
        const { error: create_error } = await supabaseAdmin.storage.createBucket(CHAT_ATTACHMENTS_BUCKET, {
          public: true,
          fileSizeLimit: MAX_CHAT_ATTACHMENT_BYTES,
        });
        if (create_error) {
          return { url: '', error: `Failed to create bucket: ${create_error.message}` };
        }
      }

      const safeExt = filenameExt.replace(/[^a-z0-9]/gi, '').slice(0, 8) || 'bin';
      const path = `${userId}/${sessionId}/${uniqueId}.${safeExt}`;

      const { error: upload_error } = await supabaseAdmin.storage
        .from(CHAT_ATTACHMENTS_BUCKET)
        .upload(path, fileBuffer, {
          contentType: contentType || 'application/octet-stream',
          upsert: false,
        });

      if (upload_error) {
        return { url: '', error: `Upload failed: ${upload_error.message}` };
      }

      const { data: urlData } = supabaseAdmin.storage.from(CHAT_ATTACHMENTS_BUCKET).getPublicUrl(path);
      if (!urlData?.publicUrl) {
        return { url: '', error: 'Failed to get.public URL' };
      }

      return { url: urlData.publicUrl, error: null };
    } catch (e) {
      return { url: '', error: e instanceof Error ? e.message : 'Unexpected upload error' };
    }
  }

  /**
   * Результаты генерации изображений (Creative Lab): публичный bucket, путь userId/generationId/file.
   */
  static async uploadGeneratedImage(
    userId: string,
    generationId: string,
    fileBuffer: Buffer,
    contentType: string,
    filenameExt: string
  ): Promise<{ url: string; error: string | null }> {
    try {
      if (fileBuffer.length > MAX_GENERATED_IMAGE_BYTES) {
        return { url: '', error: 'Изображение слишком большое для загрузки' };
      }

      const { data: buckets, error: buckets_error } = await supabaseAdmin.storage.listBuckets();
      if (buckets_error) {
        return { url: '', error: `Failed to check buckets: ${buckets_error.message}` };
      }

      const exists = buckets?.some((b) => b.name === GENERATED_IMAGES_BUCKET);
      if (!exists) {
        const { error: create_error } = await supabaseAdmin.storage.createBucket(GENERATED_IMAGES_BUCKET, {
          public: true,
          fileSizeLimit: MAX_GENERATED_IMAGE_BYTES,
        });
        if (create_error) {
          return { url: '', error: `Failed to create bucket: ${create_error.message}` };
        }
      }

      const ext = (filenameExt.replace(/[^a-z0-9]/gi, '').slice(0, 8) || 'png').replace('jpeg', 'jpg');
      const path = `${userId}/${generationId}/${randomUUID()}.${ext}`;

      const { error: upload_error } = await supabaseAdmin.storage
        .from(GENERATED_IMAGES_BUCKET)
        .upload(path, fileBuffer, {
          contentType: contentType || 'image/png',
          upsert: false,
        });

      if (upload_error) {
        return { url: '', error: `Upload failed: ${upload_error.message}` };
      }

      const { data: urlData } = supabaseAdmin.storage.from(GENERATED_IMAGES_BUCKET).getPublicUrl(path);
      if (!urlData?.publicUrl) {
        return { url: '', error: 'Failed to get public URL' };
      }

      return { url: urlData.publicUrl, error: null };
    } catch (e) {
      return { url: '', error: e instanceof Error ? e.message : 'Unexpected upload error' };
    }
  }

  static async deleteVideo(userId: string, videoId: string): Promise<{ error: string | null }> {
    try {
      const filePath = `${userId}/${videoId}.mp4`;
      
      const { error } = await supabaseAdmin.storage
        .from(VIDEO_BUCKET_NAME)
        .remove([filePath]);

      if (error) {
        console.error('Error deleting video:', error);
        return { error: `Failed to delete video: ${error.message}` };
      }

      return { error: null };
    } catch (error) {
      console.error('Unexpected error in deleteVideo:', error);
      return {
        error: error instanceof Error ? error.message : 'Unexpected error occurred',
      };
    }
  }
}
