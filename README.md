# DnD Map

Интерактивная карта для настольных ролевых игр: Мастер загружает карту и накладывает сетку, участники в реальном времени двигают фишки.

- Требования: [analitika-servis-karta-dnd.md](analitika-servis-karta-dnd.md)
- Устройство сервиса: [docs/architecture.md](docs/architecture.md)
- План доработок (управление игроками, препятствия, туман войны): [plan-dorabotok.md](plan-dorabotok.md)
- План разработки: [plan-razrabotki.md](plan-razrabotki.md)
- Развёртывание на сервере: [docs/deploy.md](docs/deploy.md)

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

Настройки сервера (`apps/server/.env`): `RATE_LIMIT=on|off` — ограничения частоты запросов (выключать только в тестах), `TRUST_PROXY=true` — за обратным прокси, чтобы лимиты считались по реальному адресу клиента.

Загруженные карты в разработке лежат на диске в `apps/server/uploads/` (папка в git не попадает; путь задаётся `UPLOADS_DIR`).

## Команды

| Команда | Что делает |
|---|---|
| `pnpm dev` | Сервер (порт 3000) и клиент (порт 5173) с автоперезагрузкой |
| `pnpm test` | Тесты (Vitest). Серверные тесты используют отдельную базу `dnd_map_test` (создаётся автоматически; другой адрес — через `TEST_DATABASE_URL`) |
| `pnpm test:e2e` | Сборка и e2e-сценарии UC-1…UC-4 в браузере (Playwright) против продакшн-сборки; база `dnd_map_e2e` создаётся сама. Вместо встроенного Chromium можно взять установленный браузер: `E2E_BROWSER_CHANNEL=msedge` (иначе один раз `pnpm exec playwright install chromium`) |
| `pnpm --filter @dnd-map/server load-test` | Нагрузочный тест против запущенного сервера (по умолчанию 20 сессий × 10 участников, 60 с; сервер запускать с `RATE_LIMIT=off`) |
| `pnpm lint` / `pnpm format` | ESLint / Prettier |
| `pnpm typecheck` | Проверка типов во всех пакетах |
| `pnpm build` | Сборка клиента и сервера |
| `pnpm --filter @dnd-map/server db:migrate` | Создать и применить миграцию после изменения `schema.prisma` |
| `pnpm --filter @dnd-map/server db:studio` | Просмотр базы в браузере |
