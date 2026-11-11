import { el, field, button } from "../lib/dom.mjs";
import {
  createOwnerApi,
  createOwnerSession,
  OwnerAccessError,
  validOwnerPassword,
} from "./api.mjs";

const MESSAGES = {
  CALLBACK_EXPIRED:
    "Ссылка из письма истекла или уже использована. Запросите новое письмо. Скопируйте ссылку с кнопки, не открывая её, и вставьте в поле кода или приглашения. Для обычного входа сначала введите пароль.",
  CALLBACK_RATE_LIMITED:
    "Почтовый сервис ограничил число попыток. Подождите и запросите новое письмо; ссылка не подтверждает вход.",
  CALLBACK_UNAVAILABLE:
    "Почтовый вход сейчас недоступен. Проверьте настройки Email/SMTP проекта и адрес возврата, затем запросите новое письмо.",
  CALLBACK_ERROR:
    "Не удалось подтвердить переход из письма. Начните вход заново или запросите новое приглашение. Ссылку и коды никому передавать не нужно.",
  INVALID_REQUEST: "Проверьте заполненные поля и повторите попытку.",
  INVALID_PROOF:
    "Не удалось подтвердить данные. Проверьте код и срок его действия.",
  ACCESS_DENIED: "Доступ владельца не подтверждён.",
  FLOW_CONFLICT: "Этот шаг уже завершён или устарел. Начните вход заново.",
  RATE_LIMITED: "Слишком много попыток. Подождите перед повторным входом.",
  UNAVAILABLE:
    "Сервис входа сейчас недоступен. Проверьте соединение и повторите позже.",
  MAIL_UNAVAILABLE:
    "Не удалось отправить письмо. В Supabase проверьте SMTP и адрес возврата https://xan-xz.github.io/schedule/admin/. Пароль и токены никому передавать не нужно.",
};

/** Sole-owner identity and every authentication decision belong to the server. */
export function renderOwnerAccess(
  target,
  {
    request = createOwnerApi(),
    bootstrapToken = "",
    bootstrapError = null,
    onAuthenticated,
  } = {},
) {
  const controller = new AbortController();
  const timers = new Set();
  let disposed = false;
  let view = 0;
  let status = null;
  let challenge = null;
  let session = null;
  let callbackError = bootstrapError
    ? [
        "CALLBACK_EXPIRED",
        "CALLBACK_RATE_LIMITED",
        "CALLBACK_UNAVAILABLE",
        "CALLBACK_ERROR",
      ].includes(bootstrapError)
      ? bootstrapError
      : "CALLBACK_ERROR"
    : null;
  let invite = callbackError ? "" : bootstrapToken;
  bootstrapToken = "";
  const feedback = el("p", {
    class: "owner-feedback",
    role: "alert",
    id: "owner-error",
  });
  function clearSecrets() {
    for (const input of target.querySelectorAll("input")) input.value = "";
  }
  function show(title, description, ...content) {
    clearSecrets();
    view++;
    feedback.textContent = "";
    const heading = el("h1", { tabindex: "-1" }, title);
    target.replaceChildren(
      el(
        "section",
        { class: "owner-card", "aria-labelledby": "owner-title" },
        el("p", { class: "owner-eyebrow" }, "UniFlow · доступ владельца"),
        heading,
        el("p", { class: "owner-description" }, description),
        feedback,
        ...content,
      ),
    );
    heading.id = "owner-title";
    heading.focus();
  }
  function delay(callback, ms) {
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (!disposed) callback();
    }, ms);
    timers.add(timer);
  }
  function errorMessage(error, context = "") {
    const message =
      error.code === "INVALID_PROOF" && context === "Подтвердить текущий пароль"
        ? "Не удалось подтвердить текущий пароль или срок действия шага. Введите уже установленный пароль. Если шаг истёк, начните заново со свежим приглашением."
        : MESSAGES[error.code] || MESSAGES.UNAVAILABLE;
    feedback.textContent =
      message +
      (error.retryAfterSeconds
        ? ` Повторите через ${Math.ceil(error.retryAfterSeconds)} с.`
        : "");
  }
  async function call(action, data = {}) {
    const ownView = view;
    const result = await request(action, data, { signal: controller.signal });
    if (disposed || view !== ownView)
      throw new OwnerAccessError("FLOW_CONFLICT");
    return result;
  }
  function input(label, { name, type = "text", ...attrs }) {
    const node = el("input", {
      name,
      type,
      required: true,
      "aria-describedby": "owner-error",
      ...attrs,
    });
    return { node, field: field(label, node) };
  }
  function codeInput(label, name) {
    return input(label, {
      name,
      inputmode: "numeric",
      pattern: "[0-9]{6}",
      minlength: "6",
      maxlength: "6",
      autocomplete: "one-time-code",
    });
  }
  function form(label, submit, ...children) {
    const send = el("button", { type: "submit", class: "primary" }, label);
    const node = el("form", { class: "owner-form" }, ...children, send);
    let pending = false;
    node.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (pending || !node.reportValidity()) return;
      const ownView = view;
      let rateLimited = false;
      pending = true;
      send.disabled = true;
      node.setAttribute("aria-busy", "true");
      feedback.textContent = "";
      try {
        const outcome = await submit();
        if (outcome?.cooldownSeconds) {
          rateLimited = true;
          delay(() => {
            if (view === ownView) {
              send.disabled = false;
              pending = false;
            }
          }, outcome.cooldownSeconds * 1000);
        }
      } catch (error) {
        if (disposed || view !== ownView) return;
        if (challenge && Date.parse(challenge.expiresAt) <= Date.now())
          clearSecrets();
        errorMessage(error, label);
        if (error.code === "RATE_LIMITED" && error.retryAfterSeconds) {
          rateLimited = true;
          delay(() => {
            if (view === ownView) {
              send.disabled = false;
              pending = false;
            }
          }, error.retryAfterSeconds * 1000);
          return;
        }
      } finally {
        node.removeAttribute("aria-busy");
        if (!rateLimited) {
          send.disabled = false;
          pending = false;
        }
      }
    });
    return node;
  }
  function reset() {
    challenge = null;
    invite = "";
    return loadStatus();
  }
  function back() {
    return button("Начать заново", reset, { class: "owner-secondary" });
  }
  function keepChallenge(response) {
    if (
      typeof response.challengeId !== "string" ||
      !Number.isFinite(Date.parse(response.expiresAt))
    )
      throw new OwnerAccessError();
    challenge = { id: response.challengeId, expiresAt: response.expiresAt };
  }
  function challengeId() {
    if (!challenge || Date.parse(challenge.expiresAt) <= Date.now()) {
      clearSecrets();
      throw new OwnerAccessError("FLOW_CONFLICT");
    }
    return challenge.id;
  }
  function expiry() {
    return el(
      "p",
      { class: "owner-note" },
      "Шаг ограничен по времени. Если код истёк, начните заново.",
    );
  }
  function showLogin() {
    const password = input("Пароль владельца", {
      name: "password",
      type: "password",
      autocomplete: "current-password",
      maxlength: "128",
    });
    show(
      "Вход владельца",
      "Для входа нужны пароль, код из письма и приложение аутентификации.",
      form(
        "Продолжить",
        async () => {
          const value = password.node.value;
          password.node.value = "";
          const response = await call("login.begin", { password: value });
          if (disposed) return;
          keepChallenge(response);
          showLoginCodes(response.emailHint);
        },
        password.field,
      ),
      el(
        "p",
        { class: "owner-note" },
        status.ownerHint
          ? `Письма отправляются только владельцу: ${status.ownerHint}.`
          : "Доступ предоставляется только владельцу, которого проверяет сервер.",
      ),
    );
  }
  function showLoginCodes(emailHint, recovery = false) {
    const renew = el("input", { type: "checkbox", name: "renewRecoveryCodes" });
    const email = input("Код или ссылка из письма", {
      name: "emailCode",
      autocomplete: "one-time-code",
      maxlength: "4096",
      spellcheck: "false",
      autocapitalize: "off",
    });
    const factor = recovery
      ? input("Резервный код", {
          name: "recoveryCode",
          autocomplete: "off",
          maxlength: "100",
          spellcheck: "false",
          autocapitalize: "off",
        })
      : codeInput("Код из приложения", "totpCode");
    const password = recovery
      ? input("Пароль владельца ещё раз", {
          name: "password",
          type: "password",
          autocomplete: "current-password",
          maxlength: "128",
        })
      : null;
    show(
      recovery ? "Восстановление доступа" : "Подтвердите вход",
      emailHint
        ? `Проверьте письмо для ${emailHint}.`
        : "Проверьте почту владельца.",
      form(
        recovery ? "Подключить новое приложение" : "Войти",
        async () => {
          const fields = {
            challengeId: challengeId(),
            emailCode: email.node.value,
            [recovery ? "recoveryCode" : "totpCode"]: factor.node.value,
            ...(!recovery && renew.checked ? { renewRecoveryCodes: true } : {}),
          };
          if (password) {
            fields.password = password.node.value;
            password.node.value = "";
          }
          // The server keeps a consumed email proof on this challenge while
          // TOTP is retried. Keep its input in memory until success or reset.
          factor.node.value = "";
          const response = await call(
            recovery ? "recovery.verify" : "login.verify",
            fields,
          );
          if (disposed) return;
          email.node.value = "";
          if (recovery) {
            keepChallenge(response);
            showEnrollment(response.enrollment, true);
          } else await authenticated(response, renew.checked);
        },
        email.field,
        factor.field,
        password?.field,
        !recovery ? field("Обновить резервные коды", renew) : null,
      ),
      button(
        recovery ? "Использовать приложение" : "Нет доступа к приложению",
        () => showLoginCodes(emailHint, !recovery),
        { class: "owner-secondary" },
      ),
      el(
        "p",
        { class: "owner-note" },
        "Если в письме есть кнопка входа, скопируйте её ссылку в поле выше. Ссылка подтвердит только этот шаг входа.",
      ),
      expiry(),
      back(),
    );
  }
  function showSetup() {
    const token = input("Одноразовый код приглашения", {
      name: "bootstrapToken",
      type: "password",
      autocomplete: "off",
      maxlength: "8192",
      spellcheck: "false",
    });
    token.node.value = invite;
    invite = "";
    const requestInvite = form("Отправить приглашение владельцу", async () => {
      const response = await call("setup.request");
      if (response.sent !== true) throw new OwnerAccessError();
      feedback.textContent =
        "Приглашение отправлено на почту владельца. Проверьте входящие письма и папку «Спам».";
      return { cooldownSeconds: Math.max(60, response.retryAfterSeconds || 0) };
    });
    show(
      "Настройка владельца",
      "Запросите новое письмо и скопируйте ссылку с его кнопки, не открывая её. Вставьте ссылку в поле приглашения. Сервер подтвердит владельца до настройки пароля.",
      form(
        "Подтвердить приглашение",
        async () => {
          const value = token.node.value;
          token.node.value = "";
          const response = await call("setup.start", { bootstrapToken: value });
          if (disposed) return;
          keepChallenge(response);
          if (!["password", "existing-password"].includes(response.step))
            throw new OwnerAccessError();
          showPassword(response.step === "existing-password");
        },
        token.field,
      ),
      el(
        "p",
        { class: "owner-note" },
        "Не отправляйте приглашение другим людям. Настройка доступна только по действующему приглашению.",
      ),
      requestInvite,
    );
  }
  function showPassword(existing = false) {
    const password = input(existing ? "Текущий пароль" : "Новый пароль", {
      name: "password",
      type: "password",
      autocomplete: existing ? "current-password" : "new-password",
      minlength: "12",
      maxlength: "72",
    });
    const confirm = input("Повторите пароль", {
      name: "passwordConfirm",
      type: "password",
      autocomplete: "new-password",
      minlength: "12",
      maxlength: "72",
    });
    password.node.addEventListener("input", () =>
      password.node.setCustomValidity(
        validOwnerPassword(password.node.value)
          ? ""
          : "Нужно не менее 12 символов и не более 72 байт UTF-8 (до 72 латинских или 36 кириллических букв).",
      ),
    );
    show(
      existing ? "Продолжите настройку владельца" : "Создайте пароль",
      existing
        ? "Аутентификатор уже подключён, но настройка UniFlow не завершена. Введите уже установленный пароль, затем подтвердите код из сохранённого приложения. Пароль и аутентификатор сохранятся."
        : "Не менее 12 символов, максимум 72 байта UTF-8 (до 72 латинских или 36 кириллических букв). Сохраните пароль в своём менеджере паролей.",
      form(
        existing ? "Подтвердить текущий пароль" : "Подключить приложение",
        async () => {
          if (!existing && password.node.value !== confirm.node.value) {
            confirm.node.setCustomValidity("Пароли должны совпадать.");
            confirm.node.reportValidity();
            return;
          }
          const value = password.node.value;
          password.node.value = confirm.node.value = "";
          const response = await call("setup.password", {
            challengeId: challengeId(),
            password: value,
          });
          if (disposed) return;
          keepChallenge(response);
          if (response.step === "existing-totp") showExistingTotp();
          else if (response.step === "totp")
            showEnrollment(response.enrollment);
          else throw new OwnerAccessError();
        },
        password.field,
        ...(!existing ? [confirm.field] : []),
      ),
      expiry(),
      back(),
    );
    confirm.node.addEventListener("input", () =>
      confirm.node.setCustomValidity(""),
    );
  }
  function showExistingTotp() {
    const code = codeInput("Код из сохранённого приложения", "totpCode");
    show(
      "Подтвердите сохранённый аутентификатор",
      "Откройте существующую запись UniFlow в вашем приложении-аутентификаторе и введите текущий шестизначный код. Новый QR-код не нужен. После подтверждения сохраните резервные коды.",
      form(
        "Завершить настройку",
        async () => {
          const value = code.node.value;
          code.node.value = "";
          const response = await call("setup.verify", {
            challengeId: challengeId(),
            totpCode: value,
          });
          if (!disposed) await authenticated(response, true);
        },
        code.field,
      ),
      expiry(),
      back(),
    );
  }
  function showEnrollment(enrollment, recovering = false) {
    if (
      typeof enrollment?.secret !== "string" ||
      typeof enrollment?.uri !== "string"
    )
      throw new OwnerAccessError();
    const qr = el(
      "div",
      {},
      el(
        "p",
        { class: "owner-note", role: "status" },
        "Подготавливаем QR-код…",
      ),
    );
    const code = codeInput("Код из нового приложения", "totpCode");
    const manual = el(
      "details",
      { class: "owner-manual" },
      el("summary", {}, "Ввести ключ вручную"),
      el(
        "p",
        {},
        "Ключ виден только во время этой настройки. Не передавайте его другим людям.",
      ),
      el("code", { class: "owner-secret" }, enrollment.secret),
    );
    show(
      recovering
        ? "Новое приложение аутентификации"
        : "Подключите приложение аутентификации",
      "Добавьте аккаунт по QR-коду или введите ключ вручную. Затем подтвердите шестизначный код.",
      qr,
      manual,
      form(
        recovering ? "Завершить восстановление" : "Завершить настройку",
        async () => {
          const value = code.node.value;
          code.node.value = "";
          const response = await call(
            recovering ? "recovery.finish" : "setup.verify",
            { challengeId: challengeId(), totpCode: value },
          );
          if (!disposed) await authenticated(response, true);
        },
        code.field,
      ),
      expiry(),
      back(),
    );
    const ownView = view;
    import("./qr.mjs")
      .then(({ enrollmentQr }) => {
        if (disposed || view !== ownView || !qr.isConnected) return;
        qr.replaceChildren(enrollmentQr(enrollment.uri));
      })
      .catch(() => {
        if (disposed || view !== ownView || !qr.isConnected) return;
        qr.replaceChildren(
          el(
            "p",
            { class: "owner-note", role: "status" },
            "QR-код недоступен. Введите ключ вручную в приложении и подтвердите код.",
          ),
        );
        manual.open = true;
      });
  }
  async function authenticated(response, requireRecovery = false) {
    if (
      requireRecovery &&
      (!Array.isArray(response.recoveryCodes) ||
        response.recoveryCodes.length !== 10)
    )
      throw new OwnerAccessError();
    session = createOwnerSession(response, request, {
      onExpired: () => {
        if (!disposed) {
          session = null;
          loadStatus();
        }
      },
    });
    challenge = null;
    const codes = response.recoveryCodes;
    delete response.recoveryCodes;
    if (Array.isArray(codes) && codes.length) {
      if (
        codes.length !== 10 ||
        codes.some((code) => typeof code !== "string" || code.length > 100)
      ) {
        session.clear();
        session = null;
        throw new OwnerAccessError();
      }
      const list = el(
        "ul",
        { class: "owner-recovery", "aria-label": "Резервные коды" },
        codes.map((code) => el("li", {}, el("code", {}, code))),
      );
      codes.fill("");
      const saved = el("input", {
        type: "checkbox",
        required: true,
        name: "savedCodes",
      });
      show(
        "Сохраните резервные коды",
        "Каждый код работает один раз. Этот список больше не будет показан. Сохраните коды вне этого устройства.",
        list,
        button(
          "Скопировать коды",
          async () => {
            try {
              await navigator.clipboard.writeText(
                Array.from(
                  list.querySelectorAll("code"),
                  (node) => node.textContent,
                ).join("\n"),
              );
              feedback.textContent =
                "Коды скопированы. Сохраните их в личном менеджере паролей.";
            } catch {
              feedback.textContent =
                "Автоматическое копирование недоступно. Выделите и сохраните коды вручную.";
            }
          },
          { class: "owner-secondary" },
        ),
        form(
          "Продолжить в управление",
          complete,
          field("Я сохранил(а) резервные коды", saved),
        ),
      );
      return;
    }
    await complete();
  }
  async function complete() {
    clearSecrets();
    target.replaceChildren();
    if (onAuthenticated) {
      await onAuthenticated(session);
      return;
    }
    show(
      "Вход подтверждён",
      `Владелец: ${session.owner.email}.`,
      form("Выйти на всех устройствах", async () => {
        let failed = false;
        try {
          await session.logoutAll();
        } catch {
          failed = true;
        }
        session = null;
        await loadStatus();
        if (failed && !disposed)
          feedback.textContent =
            "На этом устройстве выход выполнен. Сервер не подтвердил выход на остальных устройствах.";
      }),
    );
  }
  async function loadStatus() {
    show(
      "Проверяем доступ",
      "Для защищённого входа нужно соединение с сервером.",
    );
    const ownView = view;
    try {
      status = await call("status");
      if (disposed || view !== ownView) return;
      if (status.available !== true) throw new OwnerAccessError("UNAVAILABLE");
      if (status.configured === true) {
        invite = "";
        showLogin();
      } else if (status.setupRequired === true) showSetup();
      else throw new OwnerAccessError("UNAVAILABLE");
      if (callbackError) {
        errorMessage(new OwnerAccessError(callbackError));
        callbackError = null;
      }
    } catch (error) {
      if (disposed || view !== ownView) return;
      show(
        "Вход временно недоступен",
        "Защищённый сервис не подтвердил готовность к входу.",
        button("Повторить проверку", loadStatus),
      );
      errorMessage(error);
    }
  }
  loadStatus();
  return {
    dispose({ clearSession = true } = {}) {
      disposed = true;
      view++;
      controller.abort();
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      clearSecrets();
      target.replaceChildren();
      challenge = status = null;
      invite = "";
      callbackError = null;
      if (clearSession) session?.clear();
      session = null;
    },
  };
}
