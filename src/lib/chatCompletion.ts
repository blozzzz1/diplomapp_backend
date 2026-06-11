import { PlanService } from '../services/planService';

export const CHAT_TIMEOUT_MS = 120000;

const INTELLIGENCE_CHAT_URL = 'https://api.intelligence.io.solutions/api/v1/chat/completions';
const AITUNNEL_CHAT_URL = 'https://api.aitunnel.ru/v1/chat/completions';

// Keep in sync with frontend aiService.ts / aiProxy.ts
export const AITUNNEL_MODELS = [
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

export function isAITunnelModel(model: string): boolean {
  return AITUNNEL_MODELS.includes(model);
}

function isClaudeFableModel(model: string): boolean {
  const id = model.toLowerCase();
  return id === 'claude-fable-5' || id.startsWith('claude-fable');
}

function getClaudeMaxTokensCap(model: string): number | null {
  const id = model.toLowerCase();
  if (!id.startsWith('claude-')) return null;
  if (id.startsWith('claude-fable') || id.startsWith('claude-opus')) return 4096;
  return 8192;
}

export function sanitizeAitunnelChatBody(body: Record<string, unknown>, model: string): Record<string, unknown> {
  const out = { ...body };
  if (isClaudeFableModel(model)) {
    delete out.temperature;
    delete out.top_p;
    delete out.top_k;
    delete out.reasoning_effort;
    delete out.thinking;
  }
  const claudeCap = getClaudeMaxTokensCap(model);
  if (claudeCap != null) {
    const current = typeof out.max_tokens === 'number' ? out.max_tokens : undefined;
    if (current === undefined || !Number.isFinite(current) || current > claudeCap) {
      out.max_tokens = claudeCap;
    }
  }
  return out;
}

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

function extractApiErrorMessage(errorData: unknown, fallback: string): string {
  if (!errorData || typeof errorData !== 'object') return fallback;
  const payload = errorData as Record<string, unknown>;
  if (typeof payload.message === 'string' && payload.message.trim()) {
    return payload.message;
  }
  const err = payload.error;
  if (typeof err === 'string' && err.trim()) return err;
  if (err && typeof err === 'object') {
    const nested = err as Record<string, unknown>;
    if (typeof nested.message === 'string' && nested.message.trim()) {
      return nested.message;
    }
  }
  return fallback;
}

export type ChatApiMessage = { role: string; content: unknown };

/** Собирает тело запроса к провайдеру из уже отформатированных сообщений (клиент или прокси). */
export function buildChatCompletionBody(
  model: string,
  messages: ChatApiMessage[]
): Record<string, unknown> {
  const messagesPayload = messages.map((m) => ({
    ...m,
    content: m.content === '' ? ' ' : m.content,
  }));
  const data: Record<string, unknown> = { model, messages: messagesPayload };
  if (!isClaudeFableModel(model)) {
    data.temperature = 0.7;
  }
  if (isAITunnelModel(model) && model.startsWith('sonar')) {
    data.web_search_options = {};
  }
  const claudeCap = getClaudeMaxTokensCap(model);
  if (claudeCap != null) {
    data.max_tokens = claudeCap;
  } else if (model.startsWith('minimax')) {
    data.max_tokens = 40000;
  }
  return data;
}

export class ChatCompletionError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number = 502,
    public readonly code?: string
  ) {
    super(message);
    this.name = 'ChatCompletionError';
  }
}

/** Вызов Intelligence / AITUNNEL; не привязан к Express req/res. */
export async function completeChat(
  userId: string,
  model: string,
  apiMessages: ChatApiMessage[]
): Promise<string> {
  const trimmedModel = model.trim();
  if (!trimmedModel) {
    throw new ChatCompletionError('Поле model обязательно', 400);
  }

  const { allowed, error: planErr } = await PlanService.canUseChatModel(userId, trimmedModel);
  if (!allowed) {
    if (planErr) {
      throw new ChatCompletionError('Не удалось проверить тариф. Повторите позже.', 503);
    }
    throw new ChatCompletionError(
      'Модель недоступна для вашего тарифа или отключена администратором.',
      403,
      'MODEL_NOT_ALLOWED'
    );
  }

  const useAITunnel = isAITunnelModel(trimmedModel);
  const aiKey = process.env.AI_API_KEY;
  const aitunnelKey = process.env.AITUNNEL_API_KEY;
  const apiKey = useAITunnel ? aitunnelKey : aiKey;
  const apiUrl = useAITunnel ? AITUNNEL_CHAT_URL : INTELLIGENCE_CHAT_URL;

  if (!apiKey) {
    throw new ChatCompletionError(
      useAITunnel ? 'AITUNNEL_API_KEY is not configured' : 'AI_API_KEY is not configured',
      500
    );
  }

  const rawBody = buildChatCompletionBody(trimmedModel, apiMessages);
  const payload = useAITunnel ? sanitizeAitunnelChatBody(rawBody, trimmedModel) : rawBody;

  const response = await fetchWithTimeout(apiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(payload),
    timeoutMs: CHAT_TIMEOUT_MS,
  });

  const text = await response.text();
  if (!response.ok) {
    console.error(`AI chat ${response.status} (${trimmedModel}):`, text.slice(0, 800));
    let errorMessage = `Ошибка API (${response.status})`;
    try {
      const errorData = JSON.parse(text);
      errorMessage = extractApiErrorMessage(errorData, errorMessage);
    } catch {
      if (text.trim()) errorMessage = text.slice(0, 500);
    }
    if (response.status === 402 && !errorMessage.includes('Недостаточно средств')) {
      errorMessage =
        'Недостаточно средств на балансе AITUNNEL для этой модели. Пополните баланс на aitunnel.ru или выберите более дешёвую модель.';
    }
    throw new ChatCompletionError(errorMessage, response.status);
  }

  let result: Record<string, unknown>;
  try {
    result = text ? JSON.parse(text) : {};
  } catch {
    throw new ChatCompletionError('Некорректный ответ от AI-провайдера', 502);
  }

  if (result.error) {
    const err = result.error as Record<string, unknown> | string;
    const errMsg =
      typeof err === 'string'
        ? err
        : (err.message as string) ||
          ((err.error as Record<string, unknown> | undefined)?.message as string) ||
          'API returned an error';
    throw new ChatCompletionError(String(errMsg), 502);
  }

  const choices = result.choices as Array<{ message?: { content?: unknown } }> | undefined;
  const content = choices?.[0]?.message?.content;
  if (content === undefined || content === null) {
    throw new ChatCompletionError('Пустой ответ от модели', 502);
  }
  return typeof content === 'string' ? content : JSON.stringify(content);
}

/** Прокси-обёртка для POST /api/ai/chat/completions */
export async function proxyChatCompletion(
  userId: string,
  body: Record<string, unknown>
): Promise<{ status: number; data: unknown }> {
  const rawModel = body?.model;
  if (!rawModel || typeof rawModel !== 'string' || !rawModel.trim()) {
    return { status: 400, data: { error: { message: 'Поле model обязательно' } } };
  }
  const model = rawModel.trim();
  const messages = body.messages;
  if (!Array.isArray(messages)) {
    return { status: 400, data: { error: { message: 'Поле messages обязательно' } } };
  }

  try {
    const content = await completeChat(userId, model, messages as ChatApiMessage[]);
    return {
      status: 200,
      data: {
        choices: [{ message: { role: 'assistant', content } }],
      },
    };
  } catch (err) {
    if (err instanceof ChatCompletionError) {
      if (err.code === 'MODEL_NOT_ALLOWED') {
        return {
          status: err.statusCode,
          data: { error: { message: err.message, code: err.code } },
        };
      }
      return { status: err.statusCode, data: { error: { message: err.message } } };
    }
    const msg = err instanceof Error ? err.message : 'Proxy request failed';
    if (msg.includes('abort')) {
      return { status: 504, data: { error: { message: 'Таймаут запроса к AI' } } };
    }
    return { status: 502, data: { error: { message: msg } } };
  }
}
