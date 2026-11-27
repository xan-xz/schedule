import { createTelegramWebhook } from "../../../backend/telegram-webhook.mjs";
import { createTelegramSubscriptions } from "../../../backend/telegram-subscriptions.mjs";

const env = Deno.env;
Deno.serve(
  createTelegramWebhook({
    env,
    notifications: createTelegramSubscriptions({ env }),
  }),
);
