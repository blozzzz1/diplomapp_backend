-- Таблица планов пользователей (бесплатный / премиум)
-- Выполнить в Supabase SQL Editor

CREATE TABLE IF NOT EXISTS user_plans (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  plan TEXT NOT NULL DEFAULT 'free' CHECK (plan IN ('free', 'premium')),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- RLS: пользователь может читать только свой план; обновление через backend (service role)
ALTER TABLE user_plans ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own plan"
  ON user_plans FOR SELECT
  USING (auth.uid() = user_id);

-- Индекс не обязателен для PK
COMMENT ON TABLE user_plans IS 'План подписки: free (5 видео, 20 изображений/день, базовые модели) или premium (всё открыто)';
