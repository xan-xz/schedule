import { createTelegramWebhook } from "../../../backend/telegram-webhook.mjs";
import { createTelegramSubscriptions } from "../../../backend/telegram-subscriptions.mjs";
import { createTelegramSupportStore } from "../../../backend/telegram-support-store.mjs";

const env = Deno.env;
Deno.serve(
  createTelegramWebhook({
    env,
    notifications: createTelegramSubscriptions({ env }),
    support: createTelegramSupportStore({ env }),
  }),
);
