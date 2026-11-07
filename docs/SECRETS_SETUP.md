# Куда вводить токены и где брать доступы

Пароль сайта владелец задаёт лично на https://xan-xz.github.io/schedule/admin/. API key Supabase не является этим паролем. Значений секретов в документе нет.

## Серверные секреты

Откройте [Edge Functions → Secrets проекта Schedul](https://supabase.com/dashboard/project/anfwdrcazwbkkayczkxg/functions/secrets). Проверьте project ref anfwdrcazwbkkayczkxg, выберите Add new secret: точное имя — Name/Key, значение лично вставьте в Value. Не используйте frontend env, HTML/JS, seed, Git, URL, чат или логи.

| Доступ                                                    | Где взять                                                                | Куда вводить                                          | Статус                                       |
| --------------------------------------------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------- | -------------------------------------------- |
| Пароль владельца                                          | Задать лично после приглашения                                           | Форма UniFlow                                         | Не env-секрет                                |
| TOTP и резервные коды                                     | Личный setup UniFlow                                                     | Аутентификатор и закрытая копия                       | Не передавать разработчику                   |
| TELEGRAM_BOT_TOKEN                                        | Новый токен из [@BotFather](https://t.me/BotFather)                      | Edge Functions → Secrets                              | Будущий обработчик ещё не читает             |
| TELEGRAM_WEBHOOK_SECRET                                   | Новый криптографически случайный секрет                                  | Edge Functions → Secrets                              | Будущая защита webhook                       |
| SMTP для auth-писем                                       | Панель почтового провайдера                                              | Authentication → Email/SMTP                           | Native Auth, не frontend env                 |
| SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD, MAIL_FROM | Почтовый провайдер                                                       | Edge Functions → Secrets после реализации отправителя | План уведомлений                             |
| Publishable key                                           | Settings → API Keys                                                      | Публичная конфигурация                                | Не выдаёт owner-права                        |
| Secret/service-role key                                   | Settings → API Keys; runtime предоставляет встроенные ключи              | Только сервер                                         | Не копировать в браузер                      |
| SUPABASE_ACCESS_TOKEN                                     | [Account → Access Tokens](https://supabase.com/dashboard/account/tokens) | Закрытая CLI/CI при необходимости deployment          | Не пароль сайта                              |
| GitHub Actions token                                      | Actions выдаёт автоматически                                             | Workflow                                              | Новый PAT для штатного Pages deploy не нужен |
| VAPID key pair                                            | Генератор при реализации Web Push                                        | Private — сервер, public — подписка                   | Пока не реализовано                          |

Префикс SUPABASE_ зарезервирован встроенным окружением; не переопределяйте его вручную. Owner auth использует уже внедрённое окружение, нового пользовательского server secret не требует. [Secrets](https://supabase.com/docs/guides/functions/secrets), [API keys](https://supabase.com/docs/guides/getting-started/api-keys).

## Auth Dashboard перед setup

В [URL Configuration](https://supabase.com/dashboard/project/anfwdrcazwbkkayczkxg/auth/url-configuration) задайте Site URL https://xan-xz.github.io/schedule/ и точный Redirect URL https://xan-xz.github.io/schedule/admin/, сохранив нужные действующие записи. Wildcard не требуется. Даже серверное приглашение подчиняется allowlist.

Выключите публичную регистрацию, сохранив Email-вход. В MFA включите TOTP enrollment/verification. Phone/SMS для владельца запрещены guards БД. Проверьте Email/SMTP и реальную доставку; при необходимости настройте custom SMTP. Письмо может содержать magic link, а не числовой OTP; форма принимает доверенную ссылку.

Состояние Dashboard и личную доставку проверяет владелец. Mock-тест и наличие API key этого не доказывают. Далее выполните [ADMIN_ACCESS.md](ADMIN_ACCESS.md). Пароль/OTP/TOTP/ссылку агенту не передавайте.

## Telegram, почта уведомлений и Push

Старый опубликованный токен отзывается у BotFather. Новый копируется непосредственно в TELEGRAM_BOT_TOKEN; отдельный webhook secret с ним не совпадает. Токен не вставляется в браузерный URL или сохраняемую командную строку.

Сохранение токена не включает отсутствующий обработчик. Webhook, безопасная owner-привязка, очередь и доставка пока не подключены. Произвольный chat_id не авторизует владельца. Полный план — [TELEGRAM_CLIENT_PLAN.md](TELEGRAM_CLIENT_PLAN.md).

Auth SMTP и будущие письма поддержки/входов — разные отправители. Получатель уведомлений фиксируется сервером: arappayevv@gmail.com. Имена SMTP_* пока являются планом; mailto не считается автоматической отправкой.

Web Push требует отдельной пары VAPID, подписок и очереди; случайная строка не заменяет EC key pair. Реальная фоновая доставка и разрешения ОС проверяются отдельно. При утечке сначала отзовите секрет у провайдера: удаление строки не отзывает ключ и не очищает историю.
