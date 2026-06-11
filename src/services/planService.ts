import { supabaseAdmin } from '../config/supabase';

export type PlanType = 'free' | 'premium';

const DEFAULT_FREE_IMAGE_LIMIT = 20;
const DEFAULT_FREE_VIDEO_LIMIT = 5;

const DEFAULT_FREE_CHAT_MODEL_IDS = [
  'openai/gpt-oss-20b',
  'mistralai/Mistral-Nemo-Instruct-2407',
  'meta-llama/Llama-3.3-70B-Instruct',
  'meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8',
  'mistralai/Devstral-Small-2505',
  'Qwen/Qwen2.5-VL-32B-Instruct',
  'deepseek-ai/DeepSeek-R1-0528',
];

const PLAN_CONFIG_CACHE_TTL_MS = 2 * 60 * 1000; // 2 минуты
let planConfigCache: {
  data: { freeChatModelIds: string[]; freeImageLimit: number; freeVideoLimit: number };
  cachedAt: number;
} | null = null;

/** Читает конфиг тарифов из system_settings (с кэшем 2 мин) */
async function getPlanConfigFromDb(): Promise<{
  freeChatModelIds: string[];
  freeImageLimit: number;
  freeVideoLimit: number;
}> {
  if (planConfigCache && Date.now() - planConfigCache.cachedAt < PLAN_CONFIG_CACHE_TTL_MS) {
    return planConfigCache.data;
  }
  try {
    const { data, error } = await supabaseAdmin
      .from('system_settings')
      .select('key, value')
      .in('key', ['free_chat_model_ids', 'free_image_limit', 'free_video_limit']);
    if (error || !data?.length) {
      const defaults = {
        freeChatModelIds: DEFAULT_FREE_CHAT_MODEL_IDS,
        freeImageLimit: DEFAULT_FREE_IMAGE_LIMIT,
        freeVideoLimit: DEFAULT_FREE_VIDEO_LIMIT,
      };
      planConfigCache = { data: defaults, cachedAt: Date.now() };
      return defaults;
    }
    const rows = data as { key: string; value: any }[];
    const rawFreeIds = rows.find((r) => r.key === 'free_chat_model_ids')?.value;
    let freeChatModelIds: string[] = DEFAULT_FREE_CHAT_MODEL_IDS;
    if (Array.isArray(rawFreeIds)) {
      freeChatModelIds = rawFreeIds.filter((x) => typeof x === 'string');
    } else if (typeof rawFreeIds === 'string') {
      try {
        const parsed = JSON.parse(rawFreeIds);
        freeChatModelIds = Array.isArray(parsed) ? parsed.filter((x: any) => typeof x === 'string') : DEFAULT_FREE_CHAT_MODEL_IDS;
      } catch {
        // leave default
      }
    }
    const freeImageLimit = Number(rows.find((r) => r.key === 'free_image_limit')?.value);
    const freeVideoLimit = Number(rows.find((r) => r.key === 'free_video_limit')?.value);
    const result = {
      freeChatModelIds: freeChatModelIds.length > 0 ? freeChatModelIds : DEFAULT_FREE_CHAT_MODEL_IDS,
      freeImageLimit: freeImageLimit > 0 ? freeImageLimit : DEFAULT_FREE_IMAGE_LIMIT,
      freeVideoLimit: freeVideoLimit > 0 ? freeVideoLimit : DEFAULT_FREE_VIDEO_LIMIT,
    };
    planConfigCache = { data: result, cachedAt: Date.now() };
    return result;
  } catch {
    const defaults = {
      freeChatModelIds: DEFAULT_FREE_CHAT_MODEL_IDS,
      freeImageLimit: DEFAULT_FREE_IMAGE_LIMIT,
      freeVideoLimit: DEFAULT_FREE_VIDEO_LIMIT,
    };
    planConfigCache = { data: defaults, cachedAt: Date.now() };
    return defaults;
  }
}

const MODEL_ENABLED_CACHE_TTL_MS = 5 * 60 * 1000; // 5 мин
const MODEL_ENABLED_CACHE_MAX = 500;
const modelEnabledCache = new Map<string, { enabled: boolean; cachedAt: number }>();

/** Сброс кэша включения моделей (после изменений в админке). */
export function invalidateModelEnabledCache(): void {
  modelEnabledCache.clear();
}

/** Проверяет, включена ли модель в model_settings (по умолчанию да). С кэшем 5 мин. */
async function isModelEnabled(modelId: string): Promise<boolean> {
  const cached = modelEnabledCache.get(modelId);
  if (cached && Date.now() - cached.cachedAt < MODEL_ENABLED_CACHE_TTL_MS) {
    return cached.enabled;
  }
  const { data } = await supabaseAdmin
    .from('model_settings')
    .select('is_enabled')
    .eq('model_id', modelId)
    .maybeSingle();
  const enabled = data?.is_enabled !== false;
  if (modelEnabledCache.size >= MODEL_ENABLED_CACHE_MAX) {
    const oldest = [...modelEnabledCache.entries()].sort((a, b) => a[1].cachedAt - b[1].cachedAt)[0];
    if (oldest) modelEnabledCache.delete(oldest[0]);
  }
  modelEnabledCache.set(modelId, { enabled, cachedAt: Date.now() });
  return enabled;
}

/** Начало текущего дня по UTC */
function startOfTodayUtc(): string {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}T00:00:00.000Z`;
}

export class PlanService {
  /** Глобально включена ли модель (админка). Не учитывает тариф пользователя. */
  static async isModelGloballyEnabled(modelId: string): Promise<boolean> {
    return isModelEnabled(modelId);
  }

  static async getPlan(userId: string): Promise<{ plan: PlanType; error: string | null }> {
    try {
      const { data, error } = await supabaseAdmin
        .from('user_plans')
        .select('plan')
        .eq('user_id', userId)
        .maybeSingle();

      if (error) {
        console.error('PlanService.getPlan:', error);
        return { plan: 'free', error: error.message };
      }

      const plan = (data?.plan === 'premium' ? 'premium' : 'free') as PlanType;
      return { plan, error: null };
    } catch (e) {
      console.error('PlanService.getPlan:', e);
      return { plan: 'free', error: e instanceof Error ? e.message : 'Unknown error' };
    }
  }

  static async setPlan(userId: string, plan: PlanType): Promise<{ error: string | null }> {
    try {
      const { error } = await supabaseAdmin
        .from('user_plans')
        .upsert(
          { user_id: userId, plan, updated_at: new Date().toISOString() },
          { onConflict: 'user_id' }
        );

      if (error) {
        console.error('PlanService.setPlan:', error);
        return { error: error.message };
      }
      return { error: null };
    } catch (e) {
      console.error('PlanService.setPlan:', e);
      return { error: e instanceof Error ? e.message : 'Unknown error' };
    }
  }

  /** Количество созданных изображений пользователя за сегодня (UTC) */
  static async getTodayImageCount(userId: string): Promise<{ count: number; error: string | null }> {
    try {
      const from = startOfTodayUtc();
      const { count, error } = await supabaseAdmin
        .from('image_generations')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', userId)
        .gte('created_at', from);

      if (error) {
        console.error('PlanService.getTodayImageCount:', error);
        return { count: 0, error: error.message };
      }
      return { count: count ?? 0, error: null };
    } catch (e) {
      console.error('PlanService.getTodayImageCount:', e);
      return { count: 0, error: e instanceof Error ? e.message : 'Unknown error' };
    }
  }

  /** Количество созданных видео пользователя за сегодня (UTC) */
  static async getTodayVideoCount(userId: string): Promise<{ count: number; error: string | null }> {
    try {
      const from = startOfTodayUtc();
      const { count, error } = await supabaseAdmin
        .from('video_generations')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', userId)
        .gte('created_at', from);

      if (error) {
        console.error('PlanService.getTodayVideoCount:', error);
        return { count: 0, error: error.message };
      }
      return { count: count ?? 0, error: null };
    } catch (e) {
      console.error('PlanService.getTodayVideoCount:', e);
      return { count: 0, error: e instanceof Error ? e.message : 'Unknown error' };
    }
  }

  /** Можно ли создать ещё одно изображение (проверка лимита по плану) */
  static async checkImageLimit(userId: string): Promise<{ allowed: boolean; limit: number; current: number; error: string | null }> {
    const { plan } = await this.getPlan(userId);
    if (plan === 'premium') {
      return { allowed: true, limit: Infinity, current: 0, error: null };
    }
    const config = await getPlanConfigFromDb();
    const { count, error } = await this.getTodayImageCount(userId);
    if (error) return { allowed: false, limit: config.freeImageLimit, current: count, error };
    return {
      allowed: count < config.freeImageLimit,
      limit: config.freeImageLimit,
      current: count,
      error: null,
    };
  }

  /** Можно ли создать ещё одно видео (проверка лимита по плану) */
  static async checkVideoLimit(userId: string): Promise<{ allowed: boolean; limit: number; current: number; error: string | null }> {
    const { plan } = await this.getPlan(userId);
    if (plan === 'premium') {
      return { allowed: true, limit: Infinity, current: 0, error: null };
    }
    const config = await getPlanConfigFromDb();
    const { count, error } = await this.getTodayVideoCount(userId);
    if (error) return { allowed: false, limit: config.freeVideoLimit, current: count, error };
    return {
      allowed: count < config.freeVideoLimit,
      limit: config.freeVideoLimit,
      current: count,
      error: null,
    };
  }

  /** Доступна ли модель чата для пользователя (план + включена ли модель) */
  static async canUseChatModel(userId: string, modelId: string): Promise<{ allowed: boolean; error: string | null }> {
    const enabled = await isModelEnabled(modelId);
    if (!enabled) return { allowed: false, error: null };
    const { plan, error } = await this.getPlan(userId);
    if (error) return { allowed: false, error };
    if (plan === 'premium') return { allowed: true, error: null };
    const config = await getPlanConfigFromDb();
    return {
      allowed: config.freeChatModelIds.includes(modelId),
      error: null,
    };
  }
}
