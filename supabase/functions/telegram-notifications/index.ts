import { createTelegramNotificationWorker } from "../../../backend/telegram-notification-worker.mjs";

Deno.serve(createTelegramNotificationWorker({ env: Deno.env }));
