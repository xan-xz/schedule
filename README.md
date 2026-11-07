# UniFlow

Mobile-first расписание и личные задания. Четыре вкладки: **Сегодня · Неделя · Задания · Ещё**. Время всегда `Asia/Almaty` (UTC+5), независимо от устройства. Студенту не нужен аккаунт.

- Сайт: https://xan-xz.github.io/schedule/
- Бета: https://xan-xz.github.io/schedule/beta/
- Песочницы: `/beta/?demo=student`, `?demo=teacher`, `?demo=admin`.
- Управление из «Ещё»; отдельная лениво открываемая страница `/beta/manage/` или `/manage/`.

## Запуск и проверки

Node.js ≥22.19, npm. Runtime приложения — нативные ES modules без фреймворка и CDN.

```sh
npm ci
npm run dev
# http://127.0.0.1:4173/schedule/beta/
npm run lint
npm run format:check
npm test
npx playwright install chromium
npm run test:e2e
npm run build
npm run budget
npm run perf
```

Сервер разработки сжимает статику gzip как Pages; в боевом Supabase CORS разрешён только `https://xan-xz.github.io`, поэтому live API в localhost может быть недоступен. Для локального теста используй demo либо e2e fixtures, не расширяй боевой CORS ради разработки.

Для отдельного beta-кандидата:

```sh
npm run production:base
npm run build:beta -- --production-base .release/production-base
```

`npm run build` формирует production-кандидат в `dist` (публикации сам не выполняет). Отдавайте `dist` для проверки итоговой CSP и скорости: исходный dev entry остаётся модульным. Первоначальный JS/CSS минифицируются esbuild и встраиваются с точными CSP SHA-256-хешами; unsafe-inline не используется. Данные расписания в исполняемый скрипт не встраиваются. Административные инструменты остаются отдельной ленивой страницей.

## Устройство

`beta/app.mjs` — студенческая оболочка; `beta/lib/` — DOM, i18n, время, публичный клиент, IndexedDB и ICS. `beta/manage/` — роли, редактор, черновики, импорт и журнал; грузится только по запросу. `backend/core.mjs` — единая чистая модель и серверная проверка прав, без секретов. Edge handlers и SQL не входят в Pages artifact, за исключением чистого shared core. `beta/seed.json` сохраняет исходные 524 записи и provenance; bootstrap — публичный снимок выпуска с явным возрастом, обновляемый живым сервером.

Supabase PostgreSQL/Edge Functions — существующая инфраструктура. Запись через серверную сессию; пароль и привилегированный ключ в браузер не попадают. Личные задания/статусы — на устройстве, разделены по группе/подгруппе и live/demo. Кеш содержит только гостевую проекцию, без аккаунтов, посещаемости и сессий.

## Деплой

CI `ci.yml`: lint → format → unit → build → gzip budgets → Playwright. Workflow `pages.yml` запускается вручную и формирует Pages artifact:

- `channel=beta`: берёт точный архив последнего успешного production из immutable GitHub Release, сохраняет каждый файл корня и обновляет только `/beta/`. Без проверенной базы публикация блокируется.
- `channel=production`, `data_sources_reviewed=true`: та же оболочка публикуется в корне и `/beta/`; build требует флаг `--data-decision-reviewed`.

Владелец **6 ноября 2026 выбрал beta / исходный XLSX единым источником**. Переход означает чтение существующего `uf_platform` по основному URL; `group_schedule` не удаляется и не перезаписывается. Прежний HTML хранится в исходном root `index.html` только как исторический архив; текущие сборки никогда не подставляют его автоматически. Это файл прежнего канала, а production entrypoint собирается из `beta/index.html`. Подробности: `docs/RELEASE.md`.

Перед новой серверной версией применять только additive migration `backend/security-upgrade.sql`, не стартовые схемы создания таблиц. Актуальный статус применения и проверки — в SECURITY.md/RELEASE.md; наличие SQL в git само по себе не означает деплой.

## Документация

- [Аудит](docs/AUDIT.md), [план слияния](docs/MERGE_PLAN.md), [решения](docs/DECISIONS.md).
- [Архитектура](docs/ARCHITECTURE.md), [данные](docs/DATA.md), [различия источников](docs/DATA_DIFF.md), [API](docs/API.md).
- [Производительность](docs/PERF.md), [проверки](docs/QA.md), [PWA](docs/PWA.md), [дизайн](docs/DESIGN.md).
- [Безопасность](SECURITY.md), [участие в разработке](CONTRIBUTING.md), [инструкция](GUIDE.md).

## Ограничения

Push при закрытом приложении без отдельного push-транспорта не обещается: напоминания работают при открытом сайте, для фоновых напоминаний используется ICS с VALARM. Личные задачи не синхронизируются между устройствами; очистка браузера удалит их. Роль старосты не добавлена: её не было в серверной модели. В управлении сохранён русский язык; студентские словари ru/kk/en полные. Метрики Lighthouse лабораторные; WebPageTest и реальные iOS/VoiceOver/TalkBack требуют отдельной проверки. Все известные ограничения и точный статус этапов — `docs/RELEASE.md`.
## Подготовка UniFlow1.0

Новое ТЗ сверено8ноября2026. Действующий опубликованный выпуск сохранён; owner-only email+пароль+TOTP, новая модель хранения и поддержка ещё не выпущены. [Матрица готовности](docs/RELEASE_1_GAP.md), [план](docs/RELEASE_1_PLAN.md), [инвентаризация удаления](docs/REMOVAL_INVENTORY.md), [куда положить токены](docs/SECRETS_SETUP.md), [доступ владельца](docs/ADMIN_ACCESS.md), [ограничения](docs/LIMITATIONS.md).
