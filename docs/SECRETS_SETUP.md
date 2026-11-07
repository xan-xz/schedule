# Куда положить токены и где взять доступы

Для Азата, 8 ноября 2026. Значений секретов в этом документе нет. Не отправляйте пароль, Telegram-токен, SMTP-пароль, OTP, QR2FA или recovery-коды в чат, issue, README, скриншот либо файл сайта.

**Главное:** ключ Supabase не является паролем админки UniFlow. Первый production-выпуск этапа 1 с native Auth invite, личной установкой пароля, email proof, TOTP и recovery **опубликован**: source [`876150baeb64f811de73840a061aa91b61bfa7a3`](https://github.com/xan-xz/schedule/commit/876150baeb64f811de73840a061aa91b61bfa7a3), успешный [production run 42416061773](https://github.com/xan-xz/schedule/actions/runs/42416061773). Проверены immutable archive и совпадение 38 файлов корня; функции `owner-access v1`, `uniflow-api v7`, `schedule-admin v5` развёрнуты. **Личный setup не выполнен:** native Auth users 0, `configured=false`, Dashboard Auth config и реальная доставка ещё не подтверждены. Telegram, почтовые оповещения о событиях и Web Push остаются будущими этапами. Сохранение секрета не включает отсутствующий обработчик.

Для owner auth этапа 1 новый пользовательский env-секрет не нужен: встроенные ключи уже предоставляет Supabase, пароль задаётся на странице UniFlow. Обязательные действия владельца сейчас — настройки Auth ниже и личный setup. Политика пароля: минимум 12 Unicode-символов, максимум 72 байта UTF-8 без автоматического обрезания; примеры — в [ADMIN_ACCESS.md](ADMIN_ACCESS.md).

## 1. Серверные секреты: нужная страница

Откройте [Secrets проекта Schedul](https://supabase.com/dashboard/project/anfwdrcazwbkkayczkxg/functions/secrets) под своим аккаунтом Supabase. Проверьте project ref **anfwdrcazwbkkayczkxg**, затем **Edge Functions → Secrets → Add new secret**:

1. В **Name/Key** вводится только имя, например `TELEGRAM_BOT_TOKEN`.
2. В **Value** самостоятельно вставляется новое значение.
3. Нажмите **Save**. Для скриншота или сообщения используйте только имя и отметку «сохранено», без Value.

Пользовательские production secrets хранятся здесь, не в GitHub Pages и не в браузере. Префикс `SUPABASE_` зарезервирован встроенными переменными; не создавайте и не переопределяйте их вручную. [Официальная инструкция Supabase](https://supabase.com/docs/guides/functions/secrets).

## 2. Что откуда брать

| Что                               | Где взять                                                                           | Куда вводить                                                                                                 | Статус в текущем приложении                                                      |
| --------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| Пароль владельца UniFlow          | Владелец задаёт лично в одноразовом setup после подтверждения своей почты           | Только `/schedule/admin/`; ни агент, ни env-файл его не получают                                             | Setup опубликован; личная активация ещё не выполнена                             |
| `TELEGRAM_BOT_TOKEN`              | Только новый токен из официального [@BotFather](https://t.me/BotFather)             | Supabase → Edge Functions → Secrets, Name именно `TELEGRAM_BOT_TOKEN`                                        | Имя задано ТЗ; обработчик ещё не читает его                                      |
| `TELEGRAM_WEBHOOK_SECRET`         | Новый случайный секрет, сгенерированный владельцем, см. ниже                        | Та же страница Secrets                                                                                       | Планируемое имя; webhook ещё не реализован                                       |
| SMTP host/port/user/password/from | Панель выбранного почтового провайдера                                              | Для invite/email proof — Supabase Auth SMTP; для будущих уведомлений — отдельные server secrets по разделу 4 | Код отправки auth-писем реализован; провайдер/настоящая доставка не подтверждены |
| Supabase publishable key          | Проект → Settings → API Keys                                                        | Только публичная конфигурация приложения, если её действительно меняет разработчик                           | Уже настроен, менять для входа админа не требуется                               |
| Supabase secret/service-role key  | Settings → API Keys; серверные функции получают встроенные env                      | Только сервер; для штатных Edge Functions вручную копировать не нужно                                        | Приложение уже использует серверное окружение                                    |
| `SUPABASE_ACCESS_TOKEN`           | [Supabase Account → Access Tokens](https://supabase.com/dashboard/account/tokens)   | Только локальная CLI/приватная CI-настройка для deployment, если она потребуется                             | Не пароль сайта и не секрет Edge Functions                                       |
| GitHub token для Pages            | GitHub Actions выдаёт автоматически                                                 | Уже используется `${{ github.token }}`                                                                       | Новый PAT для текущего Pages deploy не нужен                                     |
| TOTP/резервные коды               | Лично в setup UniFlow: локальный QR, подтверждение приложения, 10 однократных кодов | TOTP — в форме входа; recovery — в личный менеджер паролей/offline backup                                    | Код опубликован; настройка владельцем ещё не выполнена; это не общий env-секрет  |
| VAPID key pair                    | Создаст реализация Web Push локально криптографическим генератором                  | Приватный ключ — server secret; публичный — подписка PWA                                                     | Пока не реализовано; случайная строка не заменяет EC key pair                    |

Secret/service-role обходит RLS, publishable — нет; не вставляйте административный ключ в HTML/JS или public env. Типы ключей и место их получения: [Supabase API keys](https://supabase.com/docs/guides/getting-started/api-keys). PAT для управления проектом — отдельный вид доступа: [Management API](https://supabase.com/docs/reference/api/introduction).

## Настройки Auth перед настоящим приглашением

Это необходимые настройки проекта, **не проверенные и не изменённые через Dashboard в этом этапе**. CUA остановил доступ к Windows Firefox из-за отсутствия поддержки контроля URL; авторизацию Dashboard проверить не удалось. Это не сообщение «вы не вошли» и не причина передавать пароль агенту.

1. Откройте [Authentication → URL Configuration](https://supabase.com/dashboard/project/anfwdrcazwbkkayczkxg/auth/url-configuration). **Site URL:** `https://xan-xz.github.io/schedule/`. В **Redirect URLs** добавьте ровно `https://xan-xz.github.io/schedule/admin/`, сохранив другие действующие разрешённые адреса. Wildcard не нужен. Если остаётся localhost и production не разрешён, даже privileged invite может перенаправить на localhost. [Правила redirect](https://supabase.com/docs/guides/auth/redirect-urls).
2. В Authentication → Sign In / Providers выключите **Allow new users to sign up**, сохранив Email-вход. Эквивалент конфигурации: `disable_signup=true`, `external_email_enabled=true`. DB guard дополнительно блокирует чужие регистрации и изменение owner identity, но не заменяет настройку Auth для предотвращения побочных писем отклонённой регистрации.
3. В настройках MFA включите TOTP enrollment и verification: `mfa_totp_enroll_enabled=true`, `mfa_totp_verify_enabled=true`. Это включает возможность TOTP у провайдера; собственный QR владелец подключает только в UniFlow setup. Телефон/SMS не нужны: БД запрещает владельцу `phone` и `phone_change`.
4. Проверьте Email/SMTP. Встроенный SMTP отправляет только адресам участников команды Supabase и сейчас ограничен 2 письмами в час; гарантии production-доставки нет. Убедитесь, что почта владельца допустима, либо настройте custom SMTP своего провайдера. Не добавляйте людей в команду ради доступа к UniFlow. [Ограничения SMTP](https://supabase.com/docs/guides/auth/auth-smtp).
5. Срок auth-письма задаётся отдельно от окна UniFlow; для согласования можно выставить **Email OTP Expiration = 900 секунд** (`mailer_otp_exp`). UniFlow дополнительно ограничивает начало setup своим 15-минутным окном и одноразовой email-сессией. Настоящие значения Auth config здесь не считывались.

По умолчанию `signInWithOtp` отправляет письмо с **magic-link кнопкой**, не обязательно с числовым кодом. Изменение шаблона требуется для показа `{{ .Token }}`; у новых Free-проектов с default SMTP его редактирование ограничено. В опубликованном интерфейсе можно **скопировать адрес кнопки, не открывая её**, и вставить в текущую вкладку подтверждения. Автоматический native Auth fragment с очисткой URL поддерживается при первичной настройке; при обычном входе используйте поле кода/ссылки в той же вкладке начатого входа. Уже открытая ссылка могла быть использована до ошибки redirect — тогда потребуется новое письмо после паузы. Покупать тариф только ради числового OTP не требуется. [Email OTP и ссылки](https://supabase.com/docs/guides/auth/auth-email-passwordless), [ограничение шаблонов](https://supabase.com/changelog/46599-changes-to-email-template-customisation-on-free-tier).

Конфигурацией можно управлять и через [Management API](https://supabase.com/docs/reference/api/v1-update-auth-service-config), но текущий подключённый Supabase-инструмент не предоставляет этот endpoint. Не извлекайте PAT из браузера, не присылайте его в чат и не заменяйте им API key. После проверки настроек выполните личную активацию по [ADMIN_ACCESS.md](ADMIN_ACCESS.md).

## 3. Telegram: точные шаги

1. Откройте проверенного [@BotFather](https://t.me/BotFather). Для нового бота используйте `/newbot`; для существующего выберите его в `/mybots` и управление API Token. Старый опубликованный и отозванный токен не использовать.
2. Новый токен скопируйте **напрямую** из BotFather в Value секрета `TELEGRAM_BOT_TOKEN` в Supabase. Не вставляйте его в адрес браузера, команду `curl` или исходники: URL/командная история могут его сохранить.
3. Отдельно сгенерируйте новый webhook secret: например,64случайных hex-символа в менеджере паролей. Это не токен бота. Сохраните как `TELEGRAM_WEBHOOK_SECRET`.
4. После реализации сервер сам настроит webhook с этим secret_token и проверит заголовок `X-Telegram-Bot-Api-Secret-Token`. Не публикуйте «готовую ссылку setWebhook» с токеном.
5. После реализации в защищённой админке кнопка «Подключить Telegram» выдаст одноразовый код; отправьте боту `/start <код>`. Значение `<код>` появится в вашей админке, в этой инструкции его нет. Произвольный chat_id не должен давать право привязки.
6. После реализации проверка владельцем: тестовое уведомление приходит только в привязанный чат; другой чат не получает чужие обращения или административный доступ. Публичное расписание не является секретом.

Шаги 1–3 — подготовка секретов, не обязательная для owner auth. Шаги 4–6 пока **не реализованы**. Бот планируется полноценным вторым клиентом общей системы, а не только отправителем оповещений: [этап 7Б](TELEGRAM_CLIENT_PLAN.md). Наличие секрета и работа бота не проверялись. [Создание бота](https://core.telegram.org/bots/features#creating-a-new-bot), [защита webhook](https://core.telegram.org/bots/api#setwebhook).

## 4. Почта: две разные настройки

**Для auth-писем опубликованного этапа 1:** Supabase Dashboard → Authentication → Email/SMTP → при необходимости custom SMTP: Host, Port, Username, Password, Sender email/name от выбранного вами провайдера. Это настройка native Auth, не frontend env. Код `owner-auth` опубликован как функция `owner-access v1` и вызывает native invite/OTP, но отсутствие SMTP-конфигурации или исчерпанная квота всё равно могут остановить доставку. Никакой новый платный сервис автоматически не подключён. [Supabase SMTP](https://supabase.com/docs/guides/auth/auth-smtp).

**Для будущих писем поддержки/журнала входов:** согласованный контракт следующего этапа — пользовательские Edge Secrets `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `MAIL_FROM`. Получатель arappayevv@gmail.com фиксируется сервером; клиент не выбирает адрес пересылки. Сейчас эти имена ещё не читаются кодом. Сохранение их в Auth SMTP не делает их автоматически доступными функции отправки обращений, и наоборот.

Не подключайте платный тариф только ради заполнения формы. Если используете личный Gmail и его SMTP допускает этот сценарий, для сервера понадобится отдельный **пароль приложения**, не обычный пароль Google: включите2-Step Verification → [App passwords](https://myaccount.google.com/apppasswords) → создайте пароль приложения для UniFlow и сохраните его только в серверной настройке. Опция доступна не для всех типов аккаунтов; если её нет, не отключайте2FA — нужен другой поддерживаемый почтовый способ. Это возможный вариант, не уже подключённый провайдер. [Справка Google](https://support.google.com/accounts/answer/185833).

`mailto:arappayevv@gmail.com` не требует SMTP-секрета: он открывает почтовое приложение посетителя. Это запасной канал, а не автоматическая доставка тикетов.

## 5. Где сейчас хранятся административные доступы

Развёрнутый `owner-access` (исходник `owner-auth.mjs`) читает встроенные `SUPABASE_URL`, JSON-словарь `SUPABASE_SECRET_KEYS` и fallback `SUPABASE_SERVICE_ROLE_KEY`. Новые secret keys отправляются как apikey, а не JWT Bearer; legacy key может использоваться серверным Auth admin-вызовом. Значения вручную копировать в сайт не требуется. Не отключайте существующий ключ без проверки всех потребителей. Шифрование приватного provider state использует серверный ключ; его ротация потребует новых входов, а не восстановления клиентских credentials с диска.

Новый пароль хранит native Supabase Auth как bcrypt-хеш; исторические `schedule_settings` и их хеш не являются новым входом. На сервере хешируются opaque токены и recovery-коды; provider JWT/refresh хранятся только в зашифрованном закрытом state. Не создавайте `ADMIN_PASSWORD`, `ADMIN_TOKEN`, общую TOTP seed или bootstrap-token переменную: этот код их не читает. Первичное приглашение отправляет сервер, пароль задаёт владелец. После активации публичного reset забытого пароля пока нет; TOTP recovery требует известный пароль и почту, см. [ADMIN_ACCESS.md](ADMIN_ACCESS.md).

## 6. Локальные файлы и GitHub

Предпочтительный способ — Dashboard, без файла с секретами. Если позже потребуется CLI, используйте приватный env-файл **вне каталога сайта**, например `C:\Users\porok\.uniflow\secrets.env`, и передавайте его через проверенный `--env-file`. Не создавайте его внутри публичного `dist`, исходников сервера разработки или outputs. В этом этапе такой файл не создавался.

Для будущего автоматического deployment PAT кладётся в **GitHub repo → Settings → Secrets and variables → Actions → New repository secret**, Name `SUPABASE_ACCESS_TOKEN`, только если workflow действительно его использует. Project ref — обычная Variable, не пароль. Нынешний workflow этот PAT не требует; runtime-токен Telegram туда класть вместо Edge Secrets нельзя.

Не вводите реальные значения inline в команды `secrets set NAME=value`, в shell history, логи Actions или сюда в чат. Команды CLI перед применением сверяются с установленной версией и `--help`; актуальный CLIv3 изменил выбор local/remote и поведение hosted-команд. В этой инструкции нет опасных SQL-команд сброса или фиктивной bootstrap-команды.

## Быстрый контроль

- Правильный проект: Schedul / anfwdrcazwbkkayczkxg.
- Telegram-токен новый; Name ровно TELEGRAM_BOT_TOKEN; значение только в Supabase Secrets.
- Пароль UniFlow, пароль приложения почты, PAT Supabase и ключ API — разные сущности.
- Никаких секретов в source/outputs/CI-логах/чате; только имена и состояния подключения.
- Owner auth опубликован; SMTP-доставка, Auth config и личная активация/вход владельца ещё не подтверждены. Telegram, mail-оповещения и Web Push пока не включены.
