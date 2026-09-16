const stateStore = require('./stateStore');

/**
 * Tracks the newest message id seen in a chat.
 *
 * The admin menu uses this to decide whether it can edit its existing message
 * in place, or whether newer messages have pushed it up the conversation and it
 * must repost to stay at the bottom.
 *
 * Only recorded for admin chats: customers never see that menu, so storing
 * their message ids would be write traffic for nothing.
 */

const TTL_MS = 24 * 60 * 60 * 1000;

async function noteChatMessage(chatId, messageId) {
  if (!chatId || !messageId) {
    return;
  }

  const key = stateStore.KEYS.latestChatMessage(chatId);
  const current = await stateStore.get(key, 0);

  if (Number(messageId) > Number(current || 0)) {
    await stateStore.set(key, Number(messageId), { ttlMs: TTL_MS });
  }
}

async function isMessageLatestInChat(chatId, messageId) {
  const current = await stateStore.get(stateStore.KEYS.latestChatMessage(chatId), 0);
  return Number(current || 0) === Number(messageId);
}

/**
 * The message id of an admin's self-editing menu.
 *
 * Previously a module-level userMenuMessages object. Persisted so the menu
 * survives the instance that created it, which on Vercel is routinely a
 * different one from the instance handling the next button tap.
 */
async function getMenuMessageId(userId) {
  return stateStore.get(stateStore.KEYS.adminMenuMessage(userId), null);
}

async function setMenuMessageId(userId, messageId) {
  return stateStore.set(stateStore.KEYS.adminMenuMessage(userId), messageId, { ttlMs: TTL_MS });
}

async function clearMenuMessageId(userId) {
  return stateStore.remove(stateStore.KEYS.adminMenuMessage(userId));
}

module.exports = {
  noteChatMessage,
  isMessageLatestInChat,
  getMenuMessageId,
  setMenuMessageId,
  clearMenuMessageId,
  TTL_MS,
};
