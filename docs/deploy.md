# Развёртывание

Схема: **Caddy** (HTTPS, сертификат Let's Encrypt получает сам) → **app** (API, WebSocket и сам веб-клиент, один процесс Node.js) → **PostgreSQL**. Рядом работает контейнер **backup**: раз в сутки снимает дамп базы и архив загруженных картинок. Всё описано в `deploy/docker-compose.yml`.

## Что нужно

- VPS с Linux: 1 vCPU и 1–2 ГБ памяти хватает с запасом. Нагрузочный тест (20 сессий × 10 участников, ~100 ходов и ~340 перетаскиваний в секунду) сервер выдержал с p95 задержки 38 мс и ~270 МБ памяти — это замер на рабочей машине, не на VPS.
- Docker с плагином Compose.
- Домен, A-запись которого указывает на сервер. Порты 80 и 443 открыты.

## Первый запуск

```sh
git clone <репозиторий> dnd-map && cd dnd-map
cp deploy/.env.example deploy/.env
# в deploy/.env: DOMAIN=map.example.com и POSTGRES_PASSWORD=<openssl rand -hex 24>
docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d --build
```

Проверка:

```sh
docker compose -f deploy/docker-compose.yml ps          # app и postgres — healthy
curl https://map.example.com/api/health                 # {"status":"ok","db":"ok"}
```

Миграции базы применяются автоматически при каждом старте контейнера `app`.

## Обновление

```sh
git pull
docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d --build app
```

Открытые у игроков вкладки сами переподключаются через 1–3 секунды. Если изменился протокол, на странице появится кнопка «Обновить страницу».

## Бэкапы

Файлы появляются в `deploy/backups/` на сервере:

- `db-<дата>.dump` — база (формат `pg_dump -Fc`);
- `uploads-<дата>.tar.gz` — загруженные карты и значки.

Хранятся `BACKUP_KEEP_DAYS` дней (по умолчанию 14). **Копируйте папку за пределы сервера** (rsync, облако): бэкап на том же диске не спасёт при потере сервера.

Внеочередной бэкап: `docker compose -f deploy/docker-compose.yml restart backup`.

### Восстановление

```sh
docker compose -f deploy/docker-compose.yml stop app
# база
docker compose -f deploy/docker-compose.yml exec -T postgres \
  pg_restore -U dnd_map -d dnd_map --clean --if-exists < deploy/backups/db-<дата>.dump
# картинки
docker compose -f deploy/docker-compose.yml run --rm --entrypoint sh \
  -v "$PWD/deploy/backups:/backups" app -c 'cd /data && tar -xzf /backups/uploads-<дата>.tar.gz'
docker compose -f deploy/docker-compose.yml start app
```

Процедуру стоит один раз проверить на тестовом сервере до того, как она понадобится.

## Очистка

Сервер сам раз в час удаляет сессии, к которым никто не подключался `SESSION_TTL_DAYS` дней (по умолчанию 30), вместе со всеми картами, фишками и файлами, а также файлы, на которые ничего не ссылается (старше часа). Сессии, где сейчас кто-то онлайн, не удаляются.

## Мониторинг

- `GET /api/health` — 200, если сервер и база работают, иначе 503. Подходит для внешнего пинга (UptimeRobot и т.п.).
- `GET /api/metrics` — подключения, сессии онлайн, память, время работы. Данных о людях и сессиях не содержит.
- Логи: `docker compose -f deploy/docker-compose.yml logs -f app` (JSON, ротация 5 × 10 МБ).

## Настройки app

| Переменная | По умолчанию | Что делает |
|---|---|---|
| `SESSION_TTL_DAYS` | 30 | Через сколько дней без активности сессия удаляется |
| `RATE_LIMIT` | on | Ограничения частоты запросов. Не выключать в продакшне |
| `TRUST_PROXY` | true (в образе) | Брать адрес клиента из заголовков прокси (Caddy) |
| `CLEANUP_INTERVAL_MINUTES` | 60 | Как часто запускать очистку, 0 — выключить |
