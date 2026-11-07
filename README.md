# UniFlow

Mobile-first расписание и личные задания. Четыре вкладки: **Сегодня · Неделя · Задания · Ещё**. Время всегда `Asia/Almaty` (UTC+5), независимо от устройства. Студенту не нужен аккаунт.

- Сайт: [UniFlow](https://xan-xz.github.io/schedule/).
- Владелец: [канонический вход](https://xan-xz.github.io/schedule/admin/), alias `#/admin`. Реализован в кандидате этапа 1; публикация и личный вход владельца отмечаются отдельно, см. [инструкцию](docs/ADMIN_ACCESS.md).
- Бета предыдущего конвейера: https://xan-xz.github.io/schedule/beta/
- Песочницы: `/beta/?demo=student`, `?demo=teacher`, `?demo=admin`.
- Редактор `/beta/manage/` или `/manage/` загружается отдельно; в кандидате административный доступ требует новой owner-сессии. Удаление прежних режимов — отдельный будущий этап 1.0.

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

Supabase PostgreSQL/Edge Functions — существующая инфраструктура. Запись через проверенную сервером сессию; привилегированный ключ не попадает в браузер, пароль владелец вводит только в защищённой форме и подтверждает native Auth. `backend/owner-auth.mjs` и `owner-access.mjs` реализуют новый owner boundary; `beta/admin/` содержит отдельный UI с локальным TOTP QR. Личные задания/статусы — на устройстве, разделены по группе/подгруппе и live/demo. Кеш содержит только гостевую проекцию, без аккаунтов, посещаемости и сессий.

## Деплой

CI `ci.yml`: lint → format → unit → build → gzip budgets → Playwright. Workflow `pages.yml` запускается вручную и формирует Pages artifact:

- `channel=beta`: берёт точный архив последнего успешного production из immutable GitHub Release, сохраняет каждый файл корня и обновляет только `/beta/`. Без проверенной базы публикация блокируется.
- `channel=production`, `data_sources_reviewed=true`: та же оболочка публикуется в корне и `/beta/`; build требует флаг `--data-decision-reviewed`.

Владелец **6 ноября 2026 выбрал beta / исходный XLSX единым источником**. Переход означает чтение существующего `uf_platform` по основному URL; `group_schedule` не удаляется и не перезаписывается. Прежний HTML хранится в исходном root `index.html` только как исторический архив; текущие сборки никогда не подставляют его автоматически. Это файл прежнего канала, а production entrypoint собирается из `beta/index.html`. Подробности: `docs/RELEASE.md`.

Owner auth имеет отдельную миграцию `supabase/migrations/20261107203429_owner_access.sql`, SQL-пробы и rollback до активации. Не применять стартовые схемы создания таблиц поверх живой БД. Подготовлен приватный backup вне workspace; расписание revision 5 / 19 групп / 524 занятия сохранено. После активации возврат старого password-only входа не является безопасным штатным откатом. Наличие SQL или страницы в git не доказывает deploy: точные source/run/функции/Pages/origin smoke фиксируются в итоговом отчёте этапа в outputs.

## Документация

- [Аудит](docs/AUDIT.md), [план слияния](docs/MERGE_PLAN.md), [решения](docs/DECISIONS.md).
- [Архитектура](docs/ARCHITECTURE.md), [данные](docs/DATA.md), [различия источников](docs/DATA_DIFF.md), [API](docs/API.md).
- [Производительность](docs/PERF.md), [проверки](docs/QA.md), [PWA](docs/PWA.md), [дизайн](docs/DESIGN.md).
- [Безопасность](SECURITY.md), [доступ владельца](docs/ADMIN_ACCESS.md), [секреты и Auth Dashboard](docs/SECRETS_SETUP.md), [участие в разработке](CONTRIBUTING.md), [инструкция](GUIDE.md).

## Ограничения

Push при закрытом приложении без отдельного push-транспорта не обещается: напоминания работают при открытом сайте, для фоновых напоминаний используется ICS с VALARM. Личные задачи не синхронизируются между устройствами; очистка браузера удалит их. Роль старосты не добавлена: её не было в серверной модели. В управлении сохранён русский язык; студентские словари ru/kk/en полные. Метрики Lighthouse лабораторные; WebPageTest и реальные iOS/VoiceOver/TalkBack требуют отдельной проверки. Все известные ограничения и точный статус этапов — `docs/RELEASE.md`.

## Подготовка UniFlow1.0

8 ноября 2026: **этап 1 реализован в кандидате**, публикация и настоящий owner login пока не подтверждены этим описанием. Сервер отправляет приглашение только на фиксированный email владельца; тот сам задаёт пароль, подключает TOTP и сохраняет 10 однократных кодов. Обычный вход требует пароль + свежее подтверждение почты + TOTP. Код или скопированная кнопка письма поддерживаются; native fragment очищается из URL. App credentials только в памяти: access 15 минут, rotating refresh до абсолютного 1 часа. Резервный код восстанавливает TOTP вместе с паролем/почтой; публичного сброса забытого пароля после активации пока нет.

В кандидате закреплены owner UID и TOTP-factor, native session validity, email-only DB guards; старые admin login/save закрыты, дополнительная роль admin запрещена. Подготовлены mock/HTTP/UI проверки и 21 SQL-проба с ROLLBACK, rehearsal отката до активации. Реальная почта, owner setup/login, выполнение защищённой native Auth-ролью и физические устройства не зачтены этими тестами. Dashboard Auth config остаётся отдельным шагом: CUA заблокирован из-за контроля URL Windows Firefox, а не установленного отсутствия логина.

Нормализованная модель, поддержка и новые продуктовые этапы ещё впереди. Telegram как полноценный второй клиент общей БД/auth/логики **запланирован**, не подключён: [этап 7Б](docs/TELEGRAM_CLIENT_PLAN.md). [Историческая GAP-матрица этапа 0](docs/RELEASE_1_GAP.md), [план](docs/RELEASE_1_PLAN.md), [инвентаризация удаления](docs/REMOVAL_INVENTORY.md), [ограничения](docs/LIMITATIONS.md).
