-- Системные настройки (ключ-значение): лимиты, список бесплатных моделей и т.д.
-- Выполнить в Supabase SQL Editor

CREATE TABLE IF NOT EXISTS system_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key TEXT NOT NULL UNIQUE,
  value JSONB,
  description TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by UUID REFERENCES auth.users(id) ON DELETE SET NULL
);

-- Доступ только через service role (бэкенд)
ALTER TABLE system_settings ENABLE ROW LEVEL SECURITY;

-- Политика: без разрешений для anon/authenticated (только service role)
CREATE POLICY "System settings backend only"
  ON system_settings FOR ALL
  USING (false)
  WITH CHECK (false);

COMMENT ON TABLE system_settings IS 'Системные настройки: free_chat_model_ids, free_image_limit, free_video_limit, registration_enabled, maintenance_mode и др.';

-- Начальные значения конфига тарифов (опционально)
INSERT INTO system_settings (key, value, description)
VALUES
  ('free_chat_model_ids', '[]'::jsonb, 'Массив ID чат-моделей, доступных в бесплатном плане'),
  ('free_image_limit', '20'::jsonb, 'Дневной лимит генераций изображений для бесплатного плана'),
  ('free_video_limit', '5'::jsonb, 'Дневной лимит генераций видео для бесплатного плана')
ON CONFLICT (key) DO NOTHING;
