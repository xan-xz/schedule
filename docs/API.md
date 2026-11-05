# API

## Действующий контракт и переход

Статический клиент обращается к существующему проекту Supabase. `POST /functions/v1/uniflow-api`: JSON, заголовки `Content-Type: application/json`, `apikey: <publishable key>`. Отдельный `token` в JSON нужен для защищённых действий; браузер хранит его только в памяти. Публичный ключ не даёт права записи.

Все ответы имеют `Cache-Control: no-store`. Не помещать защищённые POST-ответы в service worker/IndexedDB. Офлайн-снимок формируется клиентом только из общедоступного гостевого состояния выбранной группы. Сервер не принимает отложенные административные записи вслепую после восстановления сети: необходима актуальная ревизия.

В этой ветке `state`/ответы изменений дополнены `capabilities`:

```json
{"modelVersion":2,"teacherOverrides":true,"logoutAll":true,"allSubgroupTasks":true}
```

Работающий сервер обновлён до версии 5 и возвращает capabilities. При обращении к старой/резервной версии UI должен считать отсутствующие capability выключенными. SQL применён; состояние развёртывания и повтор — `docs/BACKEND_RELEASE.md`.

| action | Доступ и тело | Результат |
| --- | --- | --- |
| `state` | Публично: `groupId`, `subgroup` А/Б/`all`; опционально token | `data`, `revision`, `user`, разрешённые `users`, последние метаданные `versions`, capabilities |
| `login` | username, password | token, expiresAt, user; 2 часа |
| `logout` | token | Удаляет только текущую сессию |
| `logout.all` | token | Удаляет все сессии текущей личности; встроенный admin также все legacy-сессии |
| `password.change` | token, currentPassword, password (8–200 символов) | Атомарно меняет хеш и отзывает все сессии личности в обеих генерациях для встроенного admin |
| `account.save` | admin; account с username/name/role, группой/подгруппой или teacherId | Обновлённое состояние; изменения пароля/роли/группы/подгруппы/активности отзывают сессии |
| `mutate` | token, revision, op, payload | Новое состояние после транзакции |
| `rollback` | admin; token, revision, target (номер сохранённой версии) | Весь JSON выбранной версии с новой ревизией и записью журнала |

`mutate` поддерживает:

- admin: `lesson.save/delete`, `catalog.save/delete` (groups/teachers/subjects/rooms), `import`, `request.decide`;
- admin и преподаватель своих занятий: `exception.save/delete`, `task.save/delete`, `announcement.save`, `request.create`, `attendance.save`;
- guest/student: ни одной операции записи; прогресс и личные задания только локально.

`exception.save` принимает `lessonId`, исходную `date`, статус `moved`/`cancelled`; для переноса — start/end, roomId и опционально targetDate/endDayOffset. Замена subjectId/teacherId — admin. createdAt/updatedAt/actor/before/after назначает сервер, клиентские значения этих полей игнорируются. Поле type допускает обновление типа занятия. Удаление исключения восстанавливает базовую пару.

`import` принимает `payload.data` в формате экспорта UniFlow. Опциональные holidays/validFrom/validUntil заменяются только если явно присутствуют в JSON; отсутствующие поля сохраняются. holidays: [] очищает каникулы, validFrom/validUntil: null снимает соответствующую границу. Иные значения проходят полную проверку дат/ссылок. Справочники и занятия заменяются только в рамках атомарного `uf_commit` после проверки ссылок; новые исходные конфликты нельзя разрешить подложенным `sourceConflictPairs`. Текущие аккаунты, задачи, посещаемость, запросы и объявления должны сохранить валидные ссылки. Не поддерживается прямой импорт Google OAuth/CSV сервером: преобразование/предпросмотр выполняется клиентским инструментом перед обычным импортом.

Ошибки: 400 неверные поля/ссылки/конфликт ресурсов; 401 нет/истекла сессия или неверные credentials; 403 роль/владелец не разрешает действие; 409 устаревшая revision (включая гонку между чтением и commit); 413 слишком большой запрос; 429 лимит входа; 503 недоступна БД/обязательная RPC. Не повторять административный запрос с подменённой revision автоматически.

## Старый endpoint

`POST /functions/v1/schedule-admin`: прежние `login` (password), `save` (token, revision, data), `logout` сохранены; `logout.all` добавлен. Старая таблица `group_schedule` остаётся самостоятельной до согласованного объединения источников. Schema и endpoint продолжают поддерживать только дневные пары А/Б в старой модели. Клиентскую публикацию нельзя считать миграцией данных или развёртыванием Edge Function.

## Внутренние RPC обновления

Все четыре новые RPC доступны только service_role: `uf_login_attempt`, `uf_revoke_sessions`, `uf_change_password`, `uf_create_session`. Общий `uf_commit` продолжает блокировать единственную строку и сравнивать revision, хранит 30 предыдущих версий. Новые RPC описаны в аддитивном `backend/security-upgrade.sql`. Внешний клиент их не вызывает.

## Обновляемая календарная подписка

Публичный `GET /functions/v1/uniflow-calendar?group=g-main&subgroup=%D0%90&reminder=10` не требует apikey, cookie или токена. Параметры: group (или groupId) — существующая группа, subgroup — её подгруппа или all, reminder — целое 0–1440 минут. Без параметров — g-main и первая подгруппа. Горизонт всегда скользящие 112 дней с текущей даты Asia/Almaty.

Возвращает `text/calendar; charset=utf-8`, UTC DTSTART/DTEND, стабильные UID исходных встреч, переносы/отмены и VALARM при reminder>0. HTTP cache public max-age=300, ETag/If-None-Match → 304, HEAD и OPTIONS поддерживаются. Неизвестная группа 404, подгруппа/напоминание 400, запись 405, недоступная БД 503. Feed включает только публичные занятия/справочники; личные задания, посещаемость и аккаунты не экспортируются. Частота обновления подписки зависит от календарного приложения, сервер не обещает мгновенную синхронизацию.
