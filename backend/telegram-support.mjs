const groupPayload = /^report(?:_([A-Za-z0-9_-]{1,57}))?$/;
const copy = {
  ru: {
    title: "Связаться с администратором",
    prompt:
      "Напиши одним сообщением, что изменилось или что нужно проверить. Укажи дату и название пары.",
    group: "Группа",
    askGroup: "Добавь номер группы, если вопрос о расписании.",
    privacy: "Бот передаст текст администратору и доставит его ответ сюда.",
    cancel: "Отменить",
    cancelled: "Обращение отменено.",
    schedule: "К расписанию",
    sent: "Обращение отправлено. Ответ придёт в этот чат.",
    reply: "Ответ администратора UniFlow",
    respond: "Написать администратору",
    busy: "Поддержка сейчас недоступна. Попробуй позже.",
    limit: "Слишком много обращений подряд. Попробуй позже.",
    textOnly: "Отправь обращение текстом до 3000 символов.",
  },
  kk: {
    title: "Әкімшімен байланысу",
    prompt:
      "Өзгерісті немесе сұрағыңды бір хабарламаға жаз. Сабақтың күнін және атауын көрсет.",
    group: "Топ",
    askGroup: "Сұрағың сабақ кестесі туралы болса, топ нөмірін көрсет.",
    privacy: "Бот мәтінді әкімшіге жібереді, ал жауап осы чатқа келеді.",
    cancel: "Бас тарту",
    cancelled: "Өтініштен бас тарттың.",
    schedule: "Сабақ кестесіне",
    sent: "Өтініш жіберілді. Жауап осы чатқа келеді.",
    reply: "UniFlow әкімшісінің жауабы",
    respond: "Әкімшіге жазу",
    busy: "Қолдау қызметі қазір қолжетімсіз. Кейінірек қайтала.",
    limit: "Өтініштер тым жиі жіберілді. Кейінірек қайтала.",
    textOnly: "Өтінішті 3000 таңбаға дейінгі мәтінмен жібер.",
  },
};

const keyboard = (...buttons) => ({
  inline_keyboard: buttons.map(([text, callback_data]) => [
    { text, callback_data },
  ]),
});

const options = (text, ...buttons) => ({
  text,
  reply_markup: keyboard(...buttons),
});

function messageId(result) {
  const id = result?.result?.message_id;
  if (result?.ok !== true || !Number.isSafeInteger(id) || id <= 0)
    throw Error("Telegram support delivery unavailable");
  return id;
}

export async function handleTelegramSupport({
  store,
  command,
  callback,
  message,
  updateId,
  telegram,
  lookupGroup,
}) {
  const chatId = message.chat.id;
  const action = callback?.data;
  const source =
    !callback && command === "start"
      ? groupPayload.exec(message.text.trim().split(/\s+/)[1] || "")
      : null;
  const begin =
    source ||
    action === "contact" ||
    action === "contact:kk" ||
    (!callback && ["contact", "support", "report"].includes(command));
  const cancel =
    action === "supportcancel" ||
    action === "supportcancel:kk" ||
    (!callback && command === "cancel");
  if (
    !begin &&
    !cancel &&
    (callback || command || message.text?.startsWith("/"))
  )
    return undefined;

  const language =
    action === "contact:kk" ||
    action === "supportcancel:kk" ||
    (!action && message.from?.language_code?.split("-")[0] === "kk")
      ? "kk"
      : "ru";
  const phrases = copy[language];
  const back = [phrases.schedule, "faculties:0"];
  if (!store) return begin ? options(phrases.busy, back) : undefined;
  const state = await store.status(chatId);
  if (begin) {
    if (!state.ownerChatId) return options(phrases.busy, back);
    const group = source?.[1] && (await lookupGroup(source[1]));
    await store.begin(chatId, { groupId: group?.id || null, language });
    return options(
      [
        phrases.title,
        "",
        group ? phrases.group + " · " + group.name : phrases.askGroup,
        phrases.prompt,
        phrases.privacy,
      ].join("\n"),
      [
        phrases.cancel,
        language === "kk" ? "supportcancel:kk" : "supportcancel",
      ],
    );
  }
  if (cancel) {
    await store.cancel(chatId);
    return options(phrases.cancelled, back);
  }
  if (!state.ownerChatId) return undefined;

  const text = message.text?.trim();
  const replyId = message.reply_to_message?.message_id;
  if (
    String(chatId) === state.ownerChatId &&
    Number.isSafeInteger(replyId) &&
    replyId > 0
  ) {
    const route = await store.routeReply(chatId, replyId, updateId);
    if (route.code === "duplicate") return null;
    if (route.code === "busy")
      throw Error("Telegram support reply is processing");
    if (route.code === "claimed") {
      if (!text || text.length > 3000) {
        await store.releaseReply(updateId, route.leaseToken);
        return options(phrases.textOnly);
      }
      const targetCopy = copy[route.language] || copy.ru;
      try {
        messageId(
          await telegram("sendMessage", {
            chat_id: route.chatId,
            ...options(targetCopy.reply + "\n\n" + text, [
              targetCopy.respond,
              route.language === "kk" ? "contact:kk" : "contact",
            ]),
            link_preview_options: { is_disabled: true },
          }),
        );
      } catch (error) {
        if (error.status === 403) {
          await store.completeReply(updateId, route.leaseToken);
          return options(
            "Telegram не доставил ответ. Получатель мог заблокировать бота.",
          );
        }
        await store.releaseReply(updateId, route.leaseToken);
        throw error;
      }
      await store.completeReply(updateId, route.leaseToken);
      return options("Ответ отправлен.");
    }
  }

  if (state.pending && (!text || text.length > 3000)) {
    const pendingCopy = copy[state.pending.language] || phrases;
    return options(pendingCopy.textOnly, [
      pendingCopy.cancel,
      state.pending.language === "kk" ? "supportcancel:kk" : "supportcancel",
    ]);
  }
  if (!text || text.length > 3000) return undefined;
  const report = await store.claim(chatId, updateId);
  if (report.code === "duplicate") return null;
  if (report.code === "busy")
    throw Error("Telegram support report is processing");
  if (report.code === "inactive") return undefined;
  const pendingCopy = copy[report.language] || phrases;
  if (report.code === "unavailable") return options(pendingCopy.busy, back);
  if (report.code === "rate_limited") return options(pendingCopy.limit, back);
  if (report.code !== "claimed")
    throw Error("Telegram support claim unavailable");

  let deliveredId;
  try {
    const group = report.groupId && (await lookupGroup(report.groupId));
    const metadata = group ? "Группа · " + group.name + "\n" : "";
    deliveredId = messageId(
      await telegram("sendMessage", {
        chat_id: report.ownerChatId,
        text:
          "Обращение UniFlow\n" +
          metadata +
          "\n" +
          text +
          "\n\nЧтобы ответить студенту через бота, воспользуйся действием «Ответить» на это сообщение.",
        link_preview_options: { is_disabled: true },
      }),
    );
  } catch (error) {
    await store.release(report.reportId, report.leaseToken);
    if (error.status === 403) return options(pendingCopy.busy, back);
    throw error;
  }
  await store.complete(report.reportId, deliveredId, report.leaseToken);
  return options(pendingCopy.sent, back);
}
