import { createTelegramServiceRpc } from "./telegram-supabase.mjs";

export function createTelegramSubscriptions(config) {
  const unavailable = "Notification subscriptions unavailable";
  const request = createTelegramServiceRpc(
    config,
    "uf_telegram_subscription",
    unavailable,
  );
  if (!request) return undefined;

  const rpc = async (body) => {
    const result = await request(body);
    if (result === null) return null;
    if (
      typeof result?.groupId === "string" &&
      result.groupId &&
      typeof result.subgroup === "string" &&
      result.subgroup
    )
      return { groupId: result.groupId, subgroup: result.subgroup };
    throw Error(unavailable);
  };
  return {
    get: ({ chatId }) => rpc({ p_chat_id: chatId }),
    subscribe: ({ chatId, updateId, groupId, subgroup }) =>
      rpc({
        p_chat_id: chatId,
        p_update_id: updateId,
        p_group_id: groupId,
        p_subgroup: subgroup,
      }),
    unsubscribe: ({ chatId, updateId }) =>
      rpc({ p_chat_id: chatId, p_update_id: updateId }),
  };
}
