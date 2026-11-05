# API

## Действующий контракт и переход

Статический клиент обращается к существующему проекту Supabase. `POST /functions/v1/uniflow-api`: JSON, заголовки `Content-Type: application/json`, `apikey: <publishable key>`. Отдельный `token` в JSON нужен для защищённых действий; браузер хранит его только в памяти. Публичный ключ не даёт права записи.

Все ответы имеют `Cache-Control: no-store`. Не помещать защищённые POST-ответы в service worker/IndexedDB. Офлайн-снимок формируется клиентом только из общедоступного гостевого состояния выбранной группы. Сервер не принимает отложенные административные записи вслепую после восстановления сети: необходима актуальная ревизия.

В этой ветке `state`/ответы изменений дополнены `capabilities`:

```json
{"modelVersion":2,"teacherOverrides":true,"logoutAll":true,"allSubgroupTasks":true}
```

Работающий сервер версии 3 на момент аудита этого поля не имеет. UI должен считать отсутствующие capability выключенными. Установка серверной части: `SECURITY.md`; SQL ещё не применён, код ещё не развёрнут.

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

`import` принимает `payload.data` в формате экспорта UniFlow. Справочники и занятия заменяются только в рамках атомарного `uf_commit` после проверки ссылок; новые исходные конфликты нельзя разрешить подложенным `sourceConflictPairs`. Текущие аккаунты, задачи, посещаемость, запросы и объявления должны сохранить валидные ссылки. Не поддерживается прямой импорт Google OAuth/CSV сервером: преобразование/предпросмотр выполняется клиентским инструментом перед обычным импортом.

Ошибки: 400 неверные поля/ссылки/конфликт ресурсов; 401 нет/истекла сессия или неверные credentials; 403 роль/владелец не разрешает действие; 409 устаревшая revision (включая гонку между чтением и commit); 413 слишком большой запрос; 429 лимит входа; 503 недоступна БД/обязательная RPC. Не повторять административный запрос с подменённой revision автоматически.

## Старый endpoint

`POST /functions/v1/schedule-admin`: прежние `login` (password), `save` (token, revision, data), `logout` сохранены; `logout.all` добавлен. Старая таблица `group_schedule` остаётся самостоятельной до согласованного объединения источников. Schema и endpoint продолжают поддерживать только дневные пары А/Б в старой модели. Клиентскую публикацию нельзя считать миграцией данных или развёртыванием Edge Function.

## Внутренние RPC обновления

Все четыре новые RPC доступны только service_role: `uf_login_attempt`, `uf_revoke_sessions`, `uf_change_password`, `uf_create_session`. Общий `uf_commit` продолжает блокировать единственную строку и сравнивать revision, хранит 30 предыдущих версий. Новые RPC описаны в аддитивном `backend/security-upgrade.sql`. Внешний клиент их не вызывает.
