# DnD Map

Интерактивная карта для настольных ролевых игр: Мастер загружает карту и накладывает сетку, участники в реальном времени двигают фишки.

- Требования: [analitika-servis-karta-dnd.md](analitika-servis-karta-dnd.md)
- План разработки: [plan-razrabotki.md](plan-razrabotki.md)

## Структура

| Путь | Что внутри |
|---|---|
| `apps/web` | Клиент: React + Vite |
| `apps/server` | Сервер: Fastify + Socket.IO + Prisma (PostgreSQL) |
| `packages/shared` | Общий контракт событий Socket.IO и типы |

## Запуск для разработки

Нужны Node.js 22+ и PostgreSQL 15+.

1. Включить pnpm (один раз): `corepack enable`
2. Создать базу (один раз, от суперпользователя Postgres):
   ```
   psql -U postgres -f apps/server/prisma/setup-local-db.sql
   ```
   Если есть Docker, вместо этого: `docker compose up -d postgres`
3. Скопировать `apps/server/.env.example` в `apps/server/.env`
4. Установить зависимости и применить миграции:
   ```
   pnpm install
   pnpm --filter @dnd-map/server db:migrate
   ```
5. Запустить: `pnpm dev` и открыть http://localhost:5173

## Команды

| Команда | Что делает |
|---|---|
| `pnpm dev` | Сервер (порт 3000) и клиент (порт 5173) с автоперезагрузкой |
| `pnpm test` | Тесты (Vitest). Серверные тесты используют отдельную базу `dnd_map_test` (создаётся автоматически; другой адрес — через `TEST_DATABASE_URL`) |
| `pnpm lint` / `pnpm format` | ESLint / Prettier |
| `pnpm typecheck` | Проверка типов во всех пакетах |
| `pnpm build` | Сборка клиента и сервера |
| `pnpm --filter @dnd-map/server db:migrate` | Создать и применить миграцию после изменения `schema.prisma` |
| `pnpm --filter @dnd-map/server db:studio` | Просмотр базы в браузере |
