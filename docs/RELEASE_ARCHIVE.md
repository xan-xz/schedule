# Архив успешной публикации

Для будущих выпусков включена настройка GitHub immutable releases. Она не меняет ранее созданные releases или tags. Настоящая блокировка проверяется отдельно у каждого нового опубликованного выпуска; контрольная сумма и запрет перезаписи скриптом сами по себе её не доказывают.

`record-production.mjs` выполняется после успешного Pages deploy. Он проверяет source SHA и workflow run в локальной metadata, создаёт draft release, загружает только недостающие `production-site.tar` и `production.json`, после каждой записи сверяет удалённые size/state/SHA-256, затем публикует и проверяет `draft:false` и `immutable:true`. Другой source/tag, неверный digest, лишний или повторный asset останавливают работу до дальнейших изменений.

Обрыв ответа сверяется чтением фактического состояния. Скрипт продолжает уже созданный корректный draft, не перезагружает существующий совпавший файл и не использует clobber/delete. Неподтверждённая запись останавливает job; следующий осознанный запуск может продолжить сохранённый draft. Повтор полностью завершённого выпуска не создаёт новых записей. Публичный mutable release не считается успешным результатом, даже если его файлы совпали.

GitHub tag endpoint возвращает опубликованные releases. При его 404 скрипт сначала читает все страницы authenticated release list, затем получает найденный draft по numeric ID. Ошибка/неполная пагинация, неоднозначный tag или исчезнувший ID останавливают запись; 404 опубликованного tag не превращается в повторное создание draft.

Перед записью и после публикации проверяется также настоящий Git ref: автоматически создаваемый production tag должен прямо указывать на ожидаемый commit SHA. Один `target_commitish` недостаточен: GitHub игнорирует его при уже существующем tag. Чужой/аннотированный ref не заменяется и останавливает запись; штатный workflow создаёт lightweight tag.

`npm run release:restore -- --output .release/production-base` выбирает опубликованный provider-locked архив, сверяет обе скачанные контрольные суммы с GitHub, source и workflow run, затем проверяет соответствие текущему публичному release.json. Перед извлечением проверяются имена tar, типы файлов, отсутствие symlink/junction и безопасный путь внутри workspace. Команда готовит проверенную локальную копию, сама не публикует сайт и не меняет расписание.

Если immutability была выключена и появился mutable release, включите настройку и запустите новый production workflow с новым run ID. Старые assets/tag не удаляются и не заменяются. Восстановление исторического неблокированного архива требует отдельной ручной проверки; штатная команда его не выбирает.

Настройку и протокол не следует заменять сохранением access token в репозитории. Workflow использует штатный GitHub token; owner password, Supabase service key и TOTP здесь не нужны.

Проверки протокола: `node --test tests/record-production.test.mjs tests/production-base.test.mjs`. Они моделируют потерянные ответы, частичный draft, конкурентное завершение, чужие/повреждённые assets и отсутствие provider lock. Реальная блокировка подтверждается только успешной записью production release и чтением его GitHub metadata.

Официальные описания: [immutable releases](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases), [gh release create](https://cli.github.com/manual/gh_release_create), [repository setting API](https://docs.github.com/en/rest/repos/repos#enable-immutable-releases).
