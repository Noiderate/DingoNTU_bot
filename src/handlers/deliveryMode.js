const { getHalls, getFoodItems } = require('../services/googleSheets');
const keyboards = require('../utils/keyboards');
const menuTexts = require('../utils/menuTexts');
const { getActiveOrders, getLastBlockedHall, isHallBlocked } = require('../services/orderStore');

const deliveryModeViewers = {};
const latestKnownChatMessages = {};
let nextHallToPostIndex = 0;
let nextHallToPostMode = 'preorder';
const dingoMsgIds = { coming: null, here: null, 'get-ready': null };
let preorderMsgId = null;
let preorderChannelId = null;

function recordPreorderPost(channelId, msgId) {
  preorderChannelId = channelId;
  preorderMsgId = msgId;
}

function getPreorderPost() {
  return { channelId: preorderChannelId, msgId: preorderMsgId };
}

function hasPreorderPost() {
  return Boolean(preorderMsgId);
}

function recordDingoPost(mode, msgId) {
  dingoMsgIds[mode] = msgId;
}

function getDingoMsgIdsToDelete(mode) {
  const toDelete = [];
  if (mode === 'here') {
    if (dingoMsgIds.coming) toDelete.push(dingoMsgIds.coming);
    dingoMsgIds.coming = null;
  } else if (mode === 'coming') {
    if (dingoMsgIds.here) toDelete.push(dingoMsgIds.here);
    if (dingoMsgIds['get-ready']) toDelete.push(dingoMsgIds['get-ready']);
    dingoMsgIds.here = null;
    dingoMsgIds['get-ready'] = null;
  }
  return toDelete;
}

function consumeTrackedDingoMessageIds() {
  const trackedMessageIds = [
    preorderMsgId,
    dingoMsgIds.coming,
    dingoMsgIds.here,
    dingoMsgIds['get-ready'],
  ].filter(Boolean);

  preorderMsgId = null;
  preorderChannelId = null;
  dingoMsgIds.coming = null;
  dingoMsgIds.here = null;
  dingoMsgIds['get-ready'] = null;
  nextHallToPostIndex = 0;
  nextHallToPostMode = 'preorder';

  return [...new Set(trackedMessageIds)];
}

function getNextHallToPostState(halls) {
  if (!halls.length) {
    return { hall: null, mode: nextHallToPostMode };
  }

  nextHallToPostIndex %= halls.length;
  return { hall: halls[nextHallToPostIndex], mode: nextHallToPostMode };
}

function isExpectedNextHallToPost(halls, hallId, mode) {
  const { hall, mode: currentMode } = getNextHallToPostState(halls);
  if (!hall) {
    return false;
  }

  return hall.id === hallId && currentMode === mode;
}

function advanceNextHallToPost(halls, currentHallId, currentMode) {
  if (!halls.length) {
    nextHallToPostIndex = 0;
    nextHallToPostMode = 'coming';
    return { hall: null, mode: 'coming' };
  }

  if (halls.length === 1) {
    nextHallToPostIndex = 0;
    nextHallToPostMode = 'coming';
    return { hall: halls[0], mode: 'coming' };
  }

  const currentHallIndex = halls.findIndex(hall => hall.id === currentHallId);
  if (currentHallIndex === -1) {
    nextHallToPostIndex %= halls.length;
    return { hall: halls[nextHallToPostIndex], mode: nextHallToPostMode };
  }

  if (currentMode === 'get-ready') {
    nextHallToPostIndex = currentHallIndex;
    nextHallToPostMode = 'coming';
  } else if (currentMode === 'preorder' || currentMode === 'coming') {
    nextHallToPostIndex = currentHallIndex;
    nextHallToPostMode = currentMode === 'preorder' ? 'coming' : 'here';
  } else {
    // 'here' → get-ready for next hall
    nextHallToPostIndex = (currentHallIndex + 1) % halls.length;
    nextHallToPostMode = 'get-ready';
  }

  return { hall: halls[nextHallToPostIndex], mode: nextHallToPostMode };
}

async function getDeliveryModeView() {
  const halls = await getHalls();
  const foodItems = await getFoodItems();
  const orders = getActiveOrders();
  const { hall: nextHallToPost, mode: nextHallToPostMode } = getNextHallToPostState(halls);
  const nextHallToBlock = halls.find(hall => !isHallBlocked(hall.name)) || null;
  const lastBlockedHall = getLastBlockedHall();
  const allHallsBlocked = halls.length > 0 && halls.every(hall => isHallBlocked(hall.name));

  return {
    text: menuTexts.deliveryModeText(halls, orders, foodItems),
    keyboard: keyboards.deliveryModeKeyboard(nextHallToPost, nextHallToPostMode, nextHallToBlock, lastBlockedHall, allHallsBlocked),
  };
}

function setDeliveryModeViewer(userId, chatId) {
  deliveryModeViewers[userId] = chatId;
}

function clearDeliveryModeViewer(userId) {
  delete deliveryModeViewers[userId];
}

function noteChatMessage(chatId, messageId) {
  if (!chatId || !messageId) {
    return;
  }

  const currentLatestMessageId = latestKnownChatMessages[chatId] || 0;
  latestKnownChatMessages[chatId] = Math.max(currentLatestMessageId, messageId);
}

function isMessageLatestInChat(chatId, messageId) {
  return latestKnownChatMessages[chatId] === messageId;
}

async function sendDeliveryModeMenu(bot, chatId, userId, userMenuMessages) {
  const { text, keyboard } = await getDeliveryModeView();
  const currentMessageId = userMenuMessages[userId];

  if (currentMessageId && isMessageLatestInChat(chatId, currentMessageId)) {
    try {
      await bot.editMessageText(text, {
        chat_id: chatId,
        message_id: currentMessageId,
        reply_markup: keyboard,
      });
      setDeliveryModeViewer(userId, chatId);
      return;
    } catch (error) {
      if (!error.message || !error.message.includes('message is not modified')) {
        console.error(`Error editing delivery mode message for admin ${userId}:`, error.message);
      } else {
        setDeliveryModeViewer(userId, chatId);
        return;
      }
    }
  }

  if (currentMessageId) {
    try {
      await bot.deleteMessage(chatId, currentMessageId);
    } catch (error) {
      console.error(`Error deleting previous delivery mode message for admin ${userId}:`, error.message);
    }
  }

  const sentMessage = await bot.sendMessage(chatId, text, { reply_markup: keyboard });
  userMenuMessages[userId] = sentMessage.message_id;
  noteChatMessage(chatId, sentMessage.message_id);
  setDeliveryModeViewer(userId, chatId);
}

/**
 * Show the delivery mode menu
 */
async function showDeliveryModeMenu(bot, chatId, userId, userMenuMessages) {
  await sendDeliveryModeMenu(bot, chatId, userId, userMenuMessages);
}

async function refreshDeliveryModeMenus(bot, userMenuMessages) {
  const viewerIds = Object.keys(deliveryModeViewers);

  if (viewerIds.length === 0) {
    return;
  }

  for (const userId of viewerIds) {
    const chatId = deliveryModeViewers[userId];
    const messageId = userMenuMessages[userId];

    if (!messageId) {
      clearDeliveryModeViewer(userId);
      continue;
    }

    try {
      await sendDeliveryModeMenu(bot, chatId, userId, userMenuMessages);
    } catch (error) {
      clearDeliveryModeViewer(userId);
      console.error(`Error refreshing delivery mode for admin ${userId}:`, error.message);
    }
  }
}

module.exports = {
  advanceNextHallToPost,
  isExpectedNextHallToPost,
  recordDingoPost,
  getDingoMsgIdsToDelete,
  consumeTrackedDingoMessageIds,
  recordPreorderPost,
  getPreorderPost,
  hasPreorderPost,
  showDeliveryModeMenu,
  setDeliveryModeViewer,
  clearDeliveryModeViewer,
  refreshDeliveryModeMenus,
  noteChatMessage,
};
