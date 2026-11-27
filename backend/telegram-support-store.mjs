import { createTelegramServiceRpc } from "./telegram-supabase.mjs";

export function createTelegramSupportStore(config) {
  const request = createTelegramServiceRpc(
    config,
    "uf_telegram_support",
    "Telegram support unavailable",
  );
  if (!request) return undefined;

  const rpc = (action, fields) => request({ p_action: action, ...fields });
  return {
    status: (chatId) => rpc("status", { p_chat_id: chatId }),
    begin: (chatId, { groupId, language }) =>
      rpc("begin", {
        p_chat_id: chatId,
        p_group_id: groupId,
        p_language: language,
      }),
    cancel: (chatId) => rpc("cancel", { p_chat_id: chatId }),
    claim: (chatId, updateId) =>
      rpc("claim", { p_chat_id: chatId, p_update_id: updateId }),
    complete: (reportId, ownerMessageId, leaseToken) =>
      rpc("complete", {
        p_report_id: reportId,
        p_message_id: ownerMessageId,
        p_lease_token: leaseToken,
      }),
    release: (reportId, leaseToken) =>
      rpc("release", { p_report_id: reportId, p_lease_token: leaseToken }),
    routeReply: (ownerChatId, ownerMessageId, updateId) =>
      rpc("route_reply", {
        p_chat_id: ownerChatId,
        p_message_id: ownerMessageId,
        p_update_id: updateId,
      }),
    completeReply: (updateId, leaseToken) =>
      rpc("complete_reply", {
        p_update_id: updateId,
        p_lease_token: leaseToken,
      }),
    releaseReply: (updateId, leaseToken) =>
      rpc("release_reply", {
        p_update_id: updateId,
        p_lease_token: leaseToken,
      }),
  };
}
