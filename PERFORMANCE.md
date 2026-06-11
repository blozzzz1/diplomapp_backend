# Производительность бэкенда

Кратко о мерах, снижающих нагрузку и улучшающих отзывчивость:

- **Кэш авторизации** (`src/middleware/auth.ts`): результат проверки JWT кэшируется в памяти (TTL 60 с, до 500 записей), чтобы не дергать Supabase на каждый запрос.
- **Таймауты AI-прокси** (`src/routes/aiProxy.ts`): все вызовы к внешним API (чат, картинки, видео) идут через `fetchWithTimeout`; при превышении лимита возвращается 504 с понятным сообщением.
- **Кэш конфига тарифов** (`src/services/planService.ts`): `getPlanConfigFromDb()` кэшируется на 2 минуты; `isModelEnabled()` — на 5 минут (до 500 моделей), чтобы снизить чтения из `system_settings` и `model_settings`.
- **Снижение PostgREST egress** (основной источник трафика):
  - **Список чатов** (`src/services/chatService.ts`): `getUserSessions()` возвращает только метаданные сессий (id, title, updated_at, …) **без поля messages**, limit 100. Сообщения подгружаются по запросу через `getSession(id)` при открытии сессии.
  - **Списки генераций** (`src/services/generationService.ts`): `getUserImageGenerations()` и `getUserVideoGenerations()` используют прямой `select` с **limit 100** вместо RPC без лимита.

При появлении новых «узких мест» имеет смысл добавить сюда описание и место в коде.
