# Chat Backend API

Backend сервер для безопасной работы с базой данных чатов.

## Установка

1. Установите зависимости:
```bash
npm install
```

2. Создайте файл `.env` на основе `.env.example`:
```bash
cp .env.example .env
```

3. Заполните переменные окружения:
- `SUPABASE_URL` - URL вашего Supabase проекта
- `SUPABASE_SERVICE_ROLE_KEY` - Service Role Key из Supabase (для безопасности)
- `PORT` - Порт сервера (по умолчанию 3001)
- `FRONTEND_URL` - URL фронтенд приложения

## Запуск

### Режим разработки
```bash
npm run dev
```

### Продакшен
```bash
npm run build
npm start
```

## API Endpoints

Все endpoints требуют аутентификации через Bearer токен в заголовке `Authorization`.

### Chat Sessions

- `GET /api/chat/sessions` - Получить все сессии пользователя
- `GET /api/chat/sessions/:id` - Получить конкретную сессию
- `POST /api/chat/sessions` - Создать новую сессию
- `PUT /api/chat/sessions/:id` - Обновить сессию
- `DELETE /api/chat/sessions/:id` - Удалить сессию

## Безопасность

- Используется Service Role Key для доступа к БД (не доступен на фронтенде)
- Все запросы проверяются через JWT токены
- Проверка принадлежности данных пользователю на уровне API


