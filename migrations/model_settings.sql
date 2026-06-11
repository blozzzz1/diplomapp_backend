-- Статус моделей (чат, изображения, видео): включена/выключена.
-- Одна запись на модель; если записи нет — модель считается включённой.

CREATE TABLE IF NOT EXISTS model_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  model_id TEXT NOT NULL UNIQUE,
  is_enabled BOOLEAN NOT NULL DEFAULT true,
  reason TEXT,
  disabled_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  disabled_at TIMESTAMPTZ,
  enabled_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  enabled_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Доступ только через service role (бэкенд)
ALTER TABLE model_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Model settings backend only"
  ON model_settings FOR ALL
  USING (false)
  WITH CHECK (false);

COMMENT ON TABLE model_settings IS 'Включение/отключение моделей по model_id (чат, изображения, видео). Отсутствие записи = модель включена.';
