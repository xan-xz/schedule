# API

HTTPS-функции проекта доступны под /functions/v1/. uniflow-api отдаёт guest projection и выполняет разрешённые мутации; uniflow-calendar формирует публичный календарь. Публичный apikey не является административной аутентификацией.

owner-access использует POST JSON и no-store. Полный контракт actions, TTL и восстановления — [OWNER_AUTH_PROTOCOL.md](OWNER_AUTH_PROTOCOL.md). Opaque credentials используют префиксы ow1c./ow1a./ow1r.; присланная роль или обычный JWT не выдаёт права владельца.

Запись требует проверенного actor, полной валидации и ожидаемой ревизии. Старый admin login/save закрыт; выдача второго admin запрещена. Guest ответы не включают аккаунты, посещаемость, password hashes и сессии. Native credentials и server keys не возвращаются интерфейсу.

Нормализованные import/export RPC являются закрытой service-only подготовкой; они не заменяют публичный CRUD и не переключают writer. Публичные guest state и preflight разрешают чтение с любого Origin. Защищённые операции проверяют точный Origin опубликованного сайта до обращения к данным; localhost Auth проверяется только закрытыми HTTP fixtures.
