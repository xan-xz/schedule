import { consumeBootstrapCallback } from "./api.mjs";
import { setOwnerSession, clearOwnerSession } from "./session-bridge.mjs";

let { token: bootstrapToken, errorCode: bootstrapError } =
  consumeBootstrapCallback();
let access = null;
let disposed = false;
window.addEventListener("pagehide", () => {
  disposed = true;
  bootstrapToken = "";
  bootstrapError = null;
  access?.dispose();
  clearOwnerSession();
});
window.addEventListener("pageshow", (event) => {
  if (event.persisted) location.reload();
});
const notices = new URLSearchParams(location.search);
if (notices.get("notice") === "logout-unconfirmed") {
  const message = document.createElement("p");
  message.className = "owner-notice";
  message.setAttribute("role", "status");
  message.textContent =
    "Вы вышли на этом устройстве. Сервер не подтвердил завершение остальных сессий; повторите выход везде после входа.";
  document.querySelector(".owner-header").after(message);
  history.replaceState(null, "", location.pathname);
}
try {
  const { renderOwnerAccess } = await import("./access.mjs");
  if (!disposed)
    access = renderOwnerAccess(document.getElementById("owner-main"), {
      bootstrapToken,
      bootstrapError,
      async onAuthenticated(session) {
        access.dispose({ clearSession: false });
        setOwnerSession(session);
        try {
          const stylesheet = document.createElement("link");
          stylesheet.rel = "stylesheet";
          stylesheet.href = new URL(
            "../manage/styles.css",
            import.meta.url,
          ).href;
          await new Promise((resolve, reject) => {
            stylesheet.onload = resolve;
            stylesheet.onerror = reject;
            document.head.append(stylesheet);
          });
          const skip = document.createElement("a");
          skip.className = "skip";
          skip.href = "#main";
          skip.textContent = "К содержимому";
          const app = document.createElement("div");
          app.id = "app";
          app.setAttribute("aria-busy", "true");
          app.textContent = "Открываем управление…";
          const modal = document.createElement("dialog");
          modal.id = "modal";
          const toast = document.createElement("div");
          toast.id = "toast";
          toast.setAttribute("role", "status");
          toast.setAttribute("aria-live", "polite");
          document.body.className = "";
          document.body.replaceChildren(skip, app, modal, toast);
          document.title = "Управление · UniFlow";
          // A URL import keeps the workspace and its dependencies out of the
          // anonymous student bundle and the unauthenticated owner screen.
          await import(new URL("../manage/app.mjs", import.meta.url).href);
          app.removeAttribute("aria-busy");
        } catch {
          clearOwnerSession();
          document.body.replaceChildren();
          const error = document.createElement("p");
          error.textContent = "Не удалось открыть управление. Войдите ещё раз.";
          const retry = document.createElement("a");
          retry.href = new URL("./", import.meta.url).href;
          retry.textContent = "Повторить вход";
          document.body.append(error, retry);
        }
      },
    });
} catch {
  if (!disposed)
    document.getElementById("owner-main").textContent =
      "Не удалось открыть вход. Обновите страницу и повторите попытку.";
} finally {
  bootstrapToken = "";
  bootstrapError = null;
}
