# Инвентаризация удаления прежних поверхностей

Перед изменениями 32 исторических файла (docs, root README/GUIDE/CONTRIBUTING/SECURITY/index) скопированы в outputs/single-product/history-6f75229 вне репозитория. Каждый SHA-256 проверен; размеры и хеши — ARCHIVE_MANIFEST.json. Отдельно добавлен app/IMPORT.md с проверкой копии. Слова владельца и полный Telegram-план сохранены.

Единственный source — app/, root — /schedule/, вход — /schedule/admin/ и #/admin, артефакт — dist. Новая сборка ещё не опубликована; live Auth этой работой не изменяется.

Старый продукт /beta/, ?demo=student|teacher|admin, переключатели и презентационные данные удаляются. Названия beta/demo/Бета/Демо остаются только в явном manifest, минимальной совместимости, отрицательных тестах и этой истории. Второго действующего продукта быть не должно.

compatibility.json содержит legacyRoutes, retiredQueryParams, cacheScopes и storage. retirementGuard.exceptions задаёт точные {path,literals,reason}: полная trimmed строка, без regex/glob. Пустой literals допускается только для чистого файла, чей путь сам содержит запрещённое название. Изменённая строка, новый path и stale exception проваливают проверку.

Только manifest и его dist-копия, этот документ и CHANGELOG имеют явно заданное историческое исключение. Весь docs/tests/app не исключается. Проверяются tracked/untracked source и дополнительно dist независимо от .gitignore; --dist требует готовый артефакт. Symlink и нераспознанный текст fail closed; двоичные assets не считаются текстом.

Рабочие live settings/tasks/statuses/templates сохраняются с версией и приоритетом новых значений. Удаляются только известные презентационные ключи manifest: нет localStorage.clear или общего IndexedDB/cache wipe. Один HTTP404 не обезвреживает старый cache-only worker; нужен проверенный переход с прежней установки.

Личные `personal:demo:<group>:<subgroup>` не считаются презентационным dataset: это ручной ввод пользователя. `storage.personalMigrations` переносит их в `personal:live:` с приоритетом текущего ID. `statuses:demo:` и `uf.tasks.demo.*` дают прогресс только доказанным личным ID; несовпавшие статусы не становятся активными. Полные прежние тексты/статусы и completion-lists остаются в `personal-history:live:*`. Старые IDB-источники удаляются лишь после durable write, readback и атомарной compare-and-delete сверки; quota оставляет их для повторного переноса. Старые localStorage personal/completion записи остаются неактивными recovery-источниками: у localStorage нет межвкладочной compare-and-delete транзакции. `uf.demo.source.v4` остаётся удаляемым синтетическим dataset.

Финальные guard/e2e/CSP/budget результаты заполняются на точном коде. Этот документ — инвентаризация и gate, не объявление опубликованного завершения.
