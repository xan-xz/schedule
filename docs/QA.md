# Проверки

Последовательность: npm ci; lint; format:check; unit; build; `node scripts/check-retirement.mjs --dist`; budget; Playwright Chromium. Исходники и compiled артефакт проверяются отдельно.

Критические сценарии: guest reading, устойчивый выбор группы, задачи/статусы, offline/worker update, безопасная миграция адресов и локальных данных, запрет чужого admin, replay/expiry/revoke, TOTP recovery и атомарность записи.

Guard проверяет tracked/untracked пути и содержимое, а dist дополнительно сканирует независимо от .gitignore. Исключение — точный path и полная trimmed строка manifest. Новая/изменённая строка, лишний путь, stale exception и нераспознанная текстовая кодировка дают ошибку. Весь docs/tests/app не исключается.

Критические сценарии нельзя скрывать skip/flaky. Невыполненный gate остаётся открытым с причиной. Нужны отдельные реальные email/TOTP/login, iPhone/Android, VoiceOver/TalkBack, замена и откат владельцем. Mock не доказывает доставку и реальную авторизацию.

Финальный отчёт указывает commit, команды, выполненные/пропущенные сценарии, метрики и ограничения. Прежний отчёт не является результатом нового кода.
