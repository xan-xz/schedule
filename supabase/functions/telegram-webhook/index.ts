import { createTelegramWebhook } from "../../../backend/telegram-webhook.mjs";

Deno.serve(createTelegramWebhook({ env: Deno.env }));
