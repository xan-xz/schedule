# Серверный релиз: 6 ноября 2026

## Что применено

Проект Supabase `Schedul` (`anfwdrcazwbkkayczkxg`). Клиентская публикация GitHub Pages выполняется отдельно.

| Компонент | До | После |
| --- | --- | --- |
| `uniflow-api` | v3 | v4 ACTIVE |
| `schedule-admin` | v1 | v2 ACTIVE |
| `uniflow-calendar` | отсутствовал | v1 ACTIVE |
| SQL | только uf_commit | + uf_login_attempt, uf_revoke_sessions, uf_change_password, uf_create_session |

Миграция `20261105213809_security_sessions` создана командой `npx --yes supabase migration new security_sessions` после чтения CLI help. Применена через execute_sql; запись version/name/statements добавлена в существующую `supabase_migrations.schema_migrations`. Начальные schema.sql не запускались. Учебные данные не мигрировались: `uf_platform` осталась revision 5 с 524 занятиями, `group_schedule` revision 3.

Перед установкой выполнен BEGIN/ROLLBACK probe. Исходные публичные определения функций создавались/проверялись внутри транзакции; все синтетические вызовы шли по pg_temp-функциям и pg_temp-таблицам. Рабочие таблицы не переименовывались; их identity-последовательности не использовались. Проверены ACL, лимиты, две разновидности сессий, неизвестный аккаунт, ожидаемый хеш при создании сессии, атомарный отзыв после смены пароля. После ROLLBACK подтверждено отсутствие новых RPC, затем выполнено отдельное аддитивное применение.

## Точный контракт развёртывания

Использован Supabase `deploy_edge_function` с project_id выше, entrypoint_path `index.mjs`, verify_jwt `false`. Для административных функций это прежняя схема собственного серверного token; календарь намеренно публичный и не принимает записи. Никакие секреты в arguments/файлах не передавались: функции читают существующие переменные окружения Supabase.

| name | files (имя в bundle ← исходник) |
| --- | --- |
| `uniflow-api` | index.mjs ← backend/uniflow-api.mjs; core.mjs ← backend/core.mjs; security.mjs ← backend/security.mjs |
| `schedule-admin` | index.mjs ← backend/admin.mjs; security.mjs ← backend/security.mjs |
| `uniflow-calendar` | index.mjs ← backend/calendar.mjs; calendar-utils.mjs ← beta/lib/calendar.mjs; time.mjs ← beta/lib/time.mjs |

В календарном index.mjs при упаковке ровно два относительных импорта заменяются: `../beta/lib/calendar.mjs` → `./calendar-utils.mjs`, `../beta/lib/time.mjs` → `./time.mjs`. У остальных функций пути уже подходят. Внешних npm/CDN-зависимостей сервера нет.

Source-only резервные копии старых deployed handler сохранены вне Git в рабочей папке `work/secure/`: schedule-admin-v1-index.mjs, uniflow-api-v3-index.mjs, uniflow-api-v3-core.mjs. Проверка типовых credential-литералов не обнаружила ключей/токенов. Там же лежат exact deployment JSON и rollback-validation SQL. Это исходный код функций, не экспорт паролей/сессий/персональных данных.

## Проверено после установки

- guest state: HTTP 200, revision 5, 19 групп, capabilities modelVersion2/teacherOverrides/logoutAll/allSubgroupTasks true; посещаемость гостю не возвращается;
- mutate без token: 401; прямой anon PATCH uf_platform: 401; anon вызов uf_revoke_sessions: 401;
- один вход с синтетическим несуществующим логином: 401; нет созданной сессии. Одна строка account limiter удалена по точно известному synthetic-хешу; IP-попытка оставлена штатной очистке, реальные строки не удалялись;
- публичный календарь без apikey/входа: 200, text/calendar, 336 событий для А/g-main на 112 дней, UTC-время, VALARM10, cache300; If-None-Match: 304;
- security advisors: прежние 7 INFO RLS/no-policy только закрытых служебных таблиц; performance/health без замечаний;
- 37 специализированных тестов backend/model/CSV/calendar проходят. См. также общий QA проекта.

Пример подписки: [группа 06-057-25-11, А, напоминание за 10 минут](https://anfwdrcazwbkkayczkxg.supabase.co/functions/v1/uniflow-calendar?group=g-main&subgroup=%D0%90&reminder=10). Период обновления определяет календарный клиент. Установленное приложение само по себе не даёт гарантированного фонового push.

## Ограничения проверки и откат

Реальный админский/преподавательский пароль не запрашивался. Настоящий вход, изменение рабочего расписания, смена действующего пароля и отзыв действующих сессий не выполнялись: эти пути проверены pure/mock тестами и SQL synthetic probe. Рекомендуется контролируемая проверка владельцем на своей разрешённой записи перед массовым использованием.

При проблеме серверного релиза вернуть source-only bundle прежней функции с тем же name/verify_jwt. Аддитивные RPC безопасно оставить: старый сервер ими не пользуется. Откат к прежнему серверу возвращает и прежние ограничения безопасности; сначала рассмотреть исправление новой функции. Удаление новых RPC возможно только отдельной согласованной миграцией после отката обоих серверов. Учебные данные/действующие хеши для отката этого релиза не восстанавливаются, потому что релиз их не менял.

Слияние двух самостоятельных расписаний и продвижение интерфейса из beta в основной путь — отдельная стадия; см. docs/DATA.md. Серверный релиз не выбирает победителя спорных исходных строк.
