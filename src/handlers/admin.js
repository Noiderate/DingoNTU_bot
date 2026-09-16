const { isAdmin, getAdminIds, reloadAdminIds, addAdmin, deleteAdmin, getFoodItems, addFoodItem, deleteFoodItem, updateFoodItemStock, updateFoodItemStocksBatch, getHalls, addHall, deleteHall, logOrderAction, getPreorderAdminTag, getAdminUsernameById, writeToSheet } = require('../services/googleSheets');
const { CALLBACKS, STATES, isCallbackType, extractCallbackValue } = require('../config/constants');
const keyboards = require('../utils/keyboards');
const menuTexts = require('../utils/menuTexts');
const { buildComingChannelMessage } = require('../utils/channelMessages');
const { editMessageTextSafely, editMessageCaptionSafely } = require('../utils/telegramEdits');
const {
  getPendingOrder,
  confirmPendingOrder,
  rejectPendingOrder,
  setOrderAwaitingPayment,
  getActiveOrdersByHall,
  markOrderServed,
  blockHall,
  revertLastBlockedHall,
  clearBlockedHalls,
  isHallBlocked,
} = require('../services/orderStore');
const {
  advanceNextHallToPost,
  isExpectedNextHallToPost,
  recordDingoPost,
  getDingoMsgIdsToDelete,
  consumeTrackedDingoMessageIds,
  recordPreorderPost,
  getPreorderPost,
  showDeliveryModeMenu,
  setDeliveryModeViewer,
  clearDeliveryModeViewer,
  refreshDeliveryModeMenus,
} = require('./deliveryMode');

// Track user states
const adminStates = {};

// Track menu message IDs for each user (to keep menu at bottom)
const userMenuMessages = {};
const PREORDER_REFRESH_INTERVAL_MS = 5000;

let preorderRefreshInterval = null;
let isPreorderRefreshInProgress = false;
let lastPreorderMessageText = '';
let lastPreorderStartUrl = '';
let cachedBotStartUrl = '';
let isDeliveryPostInFlight = false;
const orderActionInFlight = new Set();

function createCallbackItemToken(value) {
  const text = String(value || '');
  let hash = 0;

  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash * 31) + text.charCodeAt(index)) >>> 0;
  }

  return hash.toString(36);
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatOrderServeButtonText(order) {
  const userLabel = order.username
    ? `@${order.username}`
    : `${order.userName || 'Unknown'} (${order.userId})`;
  return `#${order.id} - ${userLabel} - $${Number(order.total || 0).toFixed(2)}`;
}

function buildHallServeOrdersKeyboard(orders) {
  return {
    inline_keyboard: orders.map(order => [{
      text: formatOrderServeButtonText(order),
      callback_data: `${CALLBACKS.DELIVERY_MODE_SERVE_ORDER_PREFIX}${order.id}`,
    }]),
  };
}

async function getBotStartUrl(bot) {
  if (cachedBotStartUrl) {
    return cachedBotStartUrl;
  }

  try {
    const botInfo = await bot.getMe();
    if (!botInfo || !botInfo.username) {
      return '';
    }

    cachedBotStartUrl = `https://t.me/${botInfo.username}?start=order`;
    return cachedBotStartUrl;
  } catch (error) {
    console.error('Failed to get bot username for preorder start button:', error.message);
    return '';
  }
}

function buildPreorderStartButton(botStartUrl) {
  if (!botStartUrl) {
    return null;
  }

  return {
    inline_keyboard: [[
      { text: 'Click below to start ordering', url: botStartUrl },
    ]],
  };
}

function buildAvailableFoodLines(foodItems) {
  const availableItems = foodItems.filter(item => Number(item.stock) > 0);

  if (!availableItems.length) {
    return ['• No food currently available'];
  }

  return availableItems.map(item => `• ${escapeHtml(item.name)}`);
}

async function buildPreorderMessageText(hallLabel, preorderAdminId, adminUsername) {
  const foodItems = await getFoodItems();
  const availableFoodLines = buildAvailableFoodLines(foodItems);
  const safeHallLabel = escapeHtml(hallLabel);

  const contactLine = adminUsername
    ? `Or for any delivery related issues, message @${adminUsername}.`
    : 'Or for any delivery related issues, please contact an admin.';

  return `Preorders available for ${safeHallLabel} onwards\n\nAvailable food:\n${availableFoodLines.join('\n')}\n\nClick below to start ordering.\n${contactLine}`;
}

async function refreshPreorderChannelMessage(bot) {
  if (isPreorderRefreshInProgress) {
    return;
  }

  isPreorderRefreshInProgress = true;

  try {
    const { channelId, msgId } = getPreorderPost();
    if (!channelId || !msgId) {
      return;
    }

    const halls = await getHalls();
    const nextUnblockedHall = halls.find(hall => !isHallBlocked(hall.name));
    if (!nextUnblockedHall) {
      return;
    }

    const hallLabel = nextUnblockedHall.shortName || nextUnblockedHall.name;
    const preorderAdminId = await getPreorderAdminTag();
    const adminUsername = preorderAdminId ? await getAdminUsernameById(bot, preorderAdminId) : null;
    const messageText = await buildPreorderMessageText(hallLabel, preorderAdminId, adminUsername);
    const botStartUrl = await getBotStartUrl(bot);

    if (messageText === lastPreorderMessageText && botStartUrl === lastPreorderStartUrl) {
      return;
    }

    const editOptions = {
      chat_id: channelId,
      message_id: msgId,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    };

    const preorderButton = buildPreorderStartButton(botStartUrl);
    if (preorderButton) {
      editOptions.reply_markup = preorderButton;
    }

    await bot.editMessageText(messageText, editOptions);
    lastPreorderMessageText = messageText;
    lastPreorderStartUrl = botStartUrl;
  } catch (error) {
    if (!error.message || !error.message.includes('message is not modified')) {
      console.error('Failed to refresh preorder channel message:', error.message);
    }
  } finally {
    isPreorderRefreshInProgress = false;
  }
}

function startPreorderRefreshLoop(bot) {
  if (preorderRefreshInterval) {
    return;
  }

  preorderRefreshInterval = setInterval(() => {
    refreshPreorderChannelMessage(bot).catch(error => {
      console.error('Preorder refresh loop error:', error.message);
    });
  }, PREORDER_REFRESH_INTERVAL_MS);
}

function stopPreorderRefreshLoop() {
  if (preorderRefreshInterval) {
    clearInterval(preorderRefreshInterval);
    preorderRefreshInterval = null;
  }
  isPreorderRefreshInProgress = false;
  lastPreorderMessageText = '';
  lastPreorderStartUrl = '';
}

async function showMainAdminMenu(bot, chatId, userId) {
  await reloadAdminIds();

  const text = menuTexts.mainMenuText();
  const keyboard = keyboards.mainMenuKeyboard();
  await updateMenuMessage(bot, chatId, userId, text, keyboard);
}

/**
 * Helper function to update or send menu message (keeps it at bottom)
 */
async function updateMenuMessage(bot, chatId, userId, text, keyboard, menuMode = 'default') {
  try {
    let didUpdateMenu = false;

    if (userMenuMessages[userId]) {
      await editMessageTextSafely(bot, text, {
        chat_id: chatId,
        message_id: userMenuMessages[userId],
        reply_markup: keyboard,
      }).catch(() => {
        delete userMenuMessages[userId];
      });
      didUpdateMenu = Boolean(userMenuMessages[userId]);
    } else {
      const sentMsg = await bot.sendMessage(chatId, text, { reply_markup: keyboard });
      userMenuMessages[userId] = sentMsg.message_id;
      didUpdateMenu = true;
    }

    if (didUpdateMenu) {
      if (menuMode === 'delivery') {
        setDeliveryModeViewer(userId, chatId);
      } else {
        clearDeliveryModeViewer(userId);
      }
    }
  } catch (error) {
    console.error('Error updating menu:', error.message);
  }
}

/**
 * Handle admin commands
 */
async function handleAdminCommand(bot, msg) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const userMessage = msg.text;

  // Check if user is admin
  if (!isAdmin(userId)) {
    return false;
  }

  // Check for state-based input handling
  const userState = adminStates[userId];
  
  if (!userState) {
    // No special mode, handle regular commands
  } else if (typeof userState === 'string') {
    // Legacy string-based states
    if (userState === STATES.ADD_ADMIN) {
      const adminId = parseInt(userMessage);
      if (isNaN(adminId)) {
        await bot.sendMessage(chatId, '❌ Invalid ID. Please enter a valid number.');
        return true;
      }

      const result = await addAdmin(adminId);
      await bot.sendMessage(chatId, result.message);
      delete adminStates[userId];
      return true;
    }

    if (userState === 'add_food_item') {
      // Parse format: "name, price"
      const parts = userMessage.split(',').map(p => p.trim());
      
      if (parts.length !== 2) {
        await bot.sendMessage(chatId, '❌ Invalid format. Please use: name, price\n\nExample: Chicken Burger, 5.99');
        return true;
      }

      const name = parts[0];
      const price = parseFloat(parts[1]);

      if (isNaN(price)) {
        await bot.sendMessage(chatId, '❌ Invalid price. Please enter a valid number.');
        return true;
      }

      const result = await addFoodItem(name, price);
      await bot.sendMessage(chatId, result.message);
      delete adminStates[userId];
      return true;
    }

    if (userState === STATES.ADD_HALL) {
      const hallName = userMessage.trim();
      
      if (!hallName) {
        await bot.sendMessage(chatId, '❌ Hall name cannot be empty.');
        return true;
      }

      const result = await addHall(hallName);
      await bot.sendMessage(chatId, result.message);
      delete adminStates[userId];
      
      // Refresh halls menu
      const halls = await getHalls();
      const text = menuTexts.manageHallsText(halls);
      const keyboard = keyboards.manageHallsKeyboard();
      await updateMenuMessage(bot, chatId, userId, text, keyboard);
      return true;
    }
  } else if (typeof userState === 'object') {
    // Object-based states
    if (userState.mode === STATES.EDIT_FOOD_STOCK_SPECIFIC) {
      const newStock = parseInt(userMessage);
      if (isNaN(newStock) || newStock < 0) {
        await bot.sendMessage(chatId, '❌ Invalid stock level. Please enter a non-negative number.');
        return true;
      }

      const result = await updateFoodItemStock(userState.foodItemId, newStock);
      await bot.sendMessage(chatId, result.message);
      
      // Reload and display updated food items
      delete adminStates[userId];
      const foodItems = await getFoodItems();
      const foodText = menuTexts.manageFoodItemsText(foodItems);
      const keyboard = keyboards.manageFoodItemsKeyboard();
      await updateMenuMessage(bot, chatId, userId, foodText, keyboard);
      return true;
    }

    if (userState.mode === STATES.EDIT_ALL_FOOD_STOCK_LOOP) {
      const newStock = parseInt(userMessage);
      if (isNaN(newStock) || newStock < 0) {
        await bot.sendMessage(chatId, '❌ Invalid stock level. Please enter a non-negative number.');
        return true;
      }

      // Update current food item
      const currentItem = userState.items[userState.currentIndex];
      await updateFoodItemStock(currentItem.id, newStock);

      // Move to next item
      userState.currentIndex++;

      if (userState.currentIndex < userState.items.length) {
        // Ask for next item's stock
        const nextItem = userState.items[userState.currentIndex];
        const promptText = menuTexts.editStockPromptText(nextItem.name, nextItem.stock || 0, userState.currentIndex + 1, userState.items.length);
        const keyboard = keyboards.cancelStockEditKeyboard();
        await updateMenuMessage(bot, chatId, userId, promptText, keyboard);
        return true;
      } else {
        // All items done
        const message = menuTexts.updateCompleteText(userState.items.length);
        await bot.sendMessage(chatId, message);
        delete adminStates[userId];
        
        // Reload and display updated food items
        const updatedFoodItems = await getFoodItems();
        const foodText = menuTexts.manageFoodItemsText(updatedFoodItems);
        const keyboard = keyboards.manageFoodItemsKeyboard();
        await updateMenuMessage(bot, chatId, userId, foodText, keyboard);
        return true;
      }
    }
  }

  // /adminmenu command
  if (userMessage === '/adminmenu') {
    await showMainAdminMenu(bot, chatId, userId);
    return true;
  }

  return false;
}

/**
 * Handle admin callback queries (button clicks)
 */
async function handleAdminCallback(bot, query) {
  const chatId = query.message.chat.id;
  const userId = query.from.id;
  const data = query.data;
  const messageId = query.message.message_id;

  // Check if user is admin
  if (!isAdmin(userId)) {
    return false;
  }

  // Confirm pending order
  if (isCallbackType(data, CALLBACKS.ORDER_CONFIRM_PREFIX)) {
    const orderId = parseInt(extractCallbackValue(data, CALLBACKS.ORDER_CONFIRM_PREFIX));

    if (isNaN(orderId)) {
      await bot.answerCallbackQuery(query.id, 'Invalid order ID', { show_alert: true });
      return true;
    }

    if (orderActionInFlight.has(orderId)) {
      await bot.answerCallbackQuery(query.id, 'Another admin action is in progress for this order.');
      return true;
    }

    orderActionInFlight.add(orderId);

    try {

    const order = getPendingOrder(orderId);
    if (!order) {
      await bot.answerCallbackQuery(query.id, 'Order not found', { show_alert: true });
      return true;
    }

    if (order.status !== 'pending') {
      await bot.answerCallbackQuery(query.id, `Order already ${order.status}`, { show_alert: true });
      return true;
    }

    const confirmedOrder = confirmPendingOrder(orderId, userId);
    if (!confirmedOrder) {
      await bot.answerCallbackQuery(query.id, 'Order is already handled', { show_alert: true });
      return true;
    }

    // Mark user as awaiting payment screenshot
    setOrderAwaitingPayment(confirmedOrder.id);

    const confirmLogResult = await logOrderAction(confirmedOrder, 'confirmed', userId);

    const updatedText = `${query.message.text}\n\n✅ Status: Confirmed by admin ${userId}`;
    try {
      await editMessageTextSafely(bot, updatedText, {
        chat_id: chatId,
        message_id: messageId,
      });
    } catch (error) {
      console.error('Error updating admin order message:', error.message);
    }

    try {
      const paymentMessage = `✅ Your order #${confirmedOrder.id} has been confirmed.\nPlease follow the instruction in the screenshot above to make payment, and attach a screenshot. \n\n⚠️You have 2 minutes to make payment⚠️`;
      const paymentInstructionImage = process.env.PAYMENT_INSTRUCTION_IMAGE || process.env.PAYMENT_INSTRUCTION_IMAGE_URL || '';

      if (paymentInstructionImage) {
        await bot.sendPhoto(confirmedOrder.chatId, paymentInstructionImage, {
          caption: paymentMessage,
        });
      } else {
        await bot.sendMessage(confirmedOrder.chatId, paymentMessage);
      }
    } catch (error) {
      console.error(`Failed to notify user for confirmed order #${confirmedOrder.id}:`, error.message);
    }

    if (!confirmLogResult.success) {
      await bot.sendMessage(chatId, `⚠️ Order #${confirmedOrder.id} confirmed, but failed to log in Orders sheet.`);
    }

    await refreshDeliveryModeMenus(bot, userMenuMessages);

    await bot.answerCallbackQuery(query.id, confirmLogResult.success ? 'Order confirmed' : 'Order confirmed (log failed)');
    return true;
    } finally {
      orderActionInFlight.delete(orderId);
    }
  }

  // Reject pending order and restore stock
  if (isCallbackType(data, CALLBACKS.ORDER_REJECT_PREFIX)) {
    const orderId = parseInt(extractCallbackValue(data, CALLBACKS.ORDER_REJECT_PREFIX));

    if (isNaN(orderId)) {
      await bot.answerCallbackQuery(query.id, 'Invalid order ID', { show_alert: true });
      return true;
    }

    if (orderActionInFlight.has(orderId)) {
      await bot.answerCallbackQuery(query.id, 'Another admin action is in progress for this order.');
      return true;
    }

    orderActionInFlight.add(orderId);

    try {

    const order = getPendingOrder(orderId);
    if (!order) {
      await bot.answerCallbackQuery(query.id, 'Order not found', { show_alert: true });
      return true;
    }

    if (order.status !== 'pending') {
      await bot.answerCallbackQuery(query.id, `Order already ${order.status}`, { show_alert: true });
      return true;
    }

    const latestFoodItems = await getFoodItems();
    const restockPlan = [];

    for (const orderedItem of order.items) {
      const liveItem = latestFoodItems.find(item => item.id === orderedItem.id)
        || latestFoodItems.find(item => item.name === orderedItem.name);

      if (!liveItem) {
        await bot.answerCallbackQuery(query.id, `Cannot restore stock for ${orderedItem.name}`, { show_alert: true });
        return true;
      }

      restockPlan.push({
        id: liveItem.id,
        name: liveItem.name,
        newStock: (liveItem.stock || 0) + orderedItem.quantity,
      });
    }

    const restockResult = await updateFoodItemStocksBatch(
      restockPlan.map(restoreItem => ({
        rowId: restoreItem.id,
        newStock: restoreItem.newStock,
      }))
    );

    if (!restockResult.success) {
      await bot.answerCallbackQuery(query.id, 'Failed to restore stock', { show_alert: true });
      return true;
    }

    const rejectedOrder = rejectPendingOrder(orderId, userId);
    if (!rejectedOrder) {
      await bot.answerCallbackQuery(query.id, 'Order is already handled', { show_alert: true });
      return true;
    }

    const rejectLogResult = await logOrderAction(rejectedOrder, 'rejected', userId);

    const updatedText = `${query.message.text}\n\n❌ Status: Rejected by admin ${userId}\n↩️ Stock restored`;
    try {
      await editMessageTextSafely(bot, updatedText, {
        chat_id: chatId,
        message_id: messageId,
      });
    } catch (error) {
      console.error('Error updating admin order message:', error.message);
    }

    try {
      await bot.sendMessage(rejectedOrder.chatId, `❌ Your order #${rejectedOrder.id} was rejected. The order has been sent too late or there was an issue with the order.\n\nPlease restart your order by typing /start`);
    } catch (error) {
      console.error(`Failed to notify user for rejected order #${rejectedOrder.id}:`, error.message);
    }

    if (!rejectLogResult.success) {
      await bot.sendMessage(chatId, `⚠️ Order #${rejectedOrder.id} rejected, but failed to log in Orders sheet.`);
    }

    await bot.answerCallbackQuery(query.id, rejectLogResult.success ? 'Order rejected and stock restored' : 'Order rejected (log failed)');
    return true;
    } finally {
      orderActionInFlight.delete(orderId);
    }
  }

  // Accept payment screenshot
  if (isCallbackType(data, CALLBACKS.PAYMENT_ACCEPT_PREFIX)) {
    const orderId = parseInt(extractCallbackValue(data, CALLBACKS.PAYMENT_ACCEPT_PREFIX));

    if (isNaN(orderId)) {
      await bot.answerCallbackQuery(query.id, 'Invalid order ID', { show_alert: true });
      return true;
    }

    if (orderActionInFlight.has(orderId)) {
      await bot.answerCallbackQuery(query.id, 'Another admin action is in progress for this order.');
      return true;
    }

    orderActionInFlight.add(orderId);

    try {

    const order = getPendingOrder(orderId);
    if (!order) {
      await bot.answerCallbackQuery(query.id, 'Order not found', { show_alert: true });
      return true;
    }

    if (order.status !== 'confirmed') {
      await bot.answerCallbackQuery(query.id, `Order already ${order.status}`, { show_alert: true });
      return true;
    }

    order.status = 'paid';
    order.paymentConfirmedBy = userId;
    order.paymentConfirmedAt = new Date().toISOString();

    await logOrderAction(order, 'payment_accepted', userId);

    try {
      await editMessageCaptionSafely(
        bot,
        `${query.message.caption}\n\n✅ Payment accepted by admin ${userId}`,
        { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } }
      );
    } catch (error) {
      console.error('Error updating admin payment message:', error.message);
    }

    try {
      await bot.sendMessage(order.chatId, `✅ Payment for Order #${order.id} has been accepted! Your order is being prepared. 🍽️`);
    } catch (error) {
      console.error(`Failed to notify user of payment acceptance for order #${order.id}:`, error.message);
    }

    await refreshDeliveryModeMenus(bot, userMenuMessages);

    await bot.answerCallbackQuery(query.id, 'Payment accepted');
    return true;
    } finally {
      orderActionInFlight.delete(orderId);
    }
  }

  // Reject payment screenshot
  if (isCallbackType(data, CALLBACKS.PAYMENT_REJECT_PREFIX)) {
    const orderId = parseInt(extractCallbackValue(data, CALLBACKS.PAYMENT_REJECT_PREFIX));

    if (isNaN(orderId)) {
      await bot.answerCallbackQuery(query.id, 'Invalid order ID', { show_alert: true });
      return true;
    }

    if (orderActionInFlight.has(orderId)) {
      await bot.answerCallbackQuery(query.id, 'Another admin action is in progress for this order.');
      return true;
    }

    orderActionInFlight.add(orderId);

    try {

    const order = getPendingOrder(orderId);
    if (!order) {
      await bot.answerCallbackQuery(query.id, 'Order not found', { show_alert: true });
      return true;
    }

    if (order.status !== 'confirmed') {
      await bot.answerCallbackQuery(query.id, `Order already ${order.status}`, { show_alert: true });
      return true;
    }

    // Restore stock
    const latestFoodItems = await getFoodItems();
    const restockPlan = [];

    for (const orderedItem of order.items) {
      const liveItem = latestFoodItems.find(item => item.id === orderedItem.id)
        || latestFoodItems.find(item => item.name === orderedItem.name);

      if (!liveItem) {
        await bot.answerCallbackQuery(query.id, `Cannot restore stock for ${orderedItem.name}`, { show_alert: true });
        return true;
      }

      restockPlan.push({
        rowId: liveItem.id,
        newStock: (liveItem.stock || 0) + orderedItem.quantity,
      });
    }

    const restockResult = await updateFoodItemStocksBatch(restockPlan);
    if (!restockResult.success) {
      await bot.answerCallbackQuery(query.id, 'Failed to restore stock', { show_alert: true });
      return true;
    }

    order.status = 'payment_rejected';
    order.paymentRejectedBy = userId;
    order.paymentRejectedAt = new Date().toISOString();

    await logOrderAction(order, 'payment_rejected', userId);

    try {
      await editMessageCaptionSafely(
        bot,
        `${query.message.caption}\n\n❌ Payment rejected by admin ${userId}\n↩️ Stock restored`,
        { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } }
      );
    } catch (error) {
      console.error('Error updating admin payment message:', error.message);
    }

    try {
      await bot.sendMessage(order.chatId, `❌ Payment for Order #${order.id} was rejected.\n\nPlease restart your order by typing /start`);
    } catch (error) {
      console.error(`Failed to notify user of payment rejection for order #${order.id}:`, error.message);
    }

    await refreshDeliveryModeMenus(bot, userMenuMessages);

    await bot.answerCallbackQuery(query.id, 'Payment rejected and stock restored');
    return true;
    } finally {
      orderActionInFlight.delete(orderId);
    }
  }

  // Settings menu
  if (data === CALLBACKS.ADMIN_SETTINGS) {
    const text = menuTexts.settingsMenuText();
    const keyboard = keyboards.settingsMenuKeyboard();
    await updateMenuMessage(bot, chatId, userId, text, keyboard);
    await bot.answerCallbackQuery(query.id);
    return true;
  }

  // Stats
  if (data === CALLBACKS.ADMIN_STATS) {
    const adminCount = getAdminIds().length;
    const text = menuTexts.adminStatsText(adminCount);
    const keyboard = keyboards.backToMainMenuKeyboard();
    await updateMenuMessage(bot, chatId, userId, text, keyboard);
    await bot.answerCallbackQuery(query.id);
    return true;
  }

  // Reload settings
  if (data === CALLBACKS.ADMIN_RELOAD) {
    const success = await reloadAdminIds();
    const text = menuTexts.reloadText(success);
    const keyboard = keyboards.backToMainMenuKeyboard();
    await updateMenuMessage(bot, chatId, userId, text, keyboard);
    await bot.answerCallbackQuery(query.id);
    return true;
  }

  // Manage admins
  if (data === CALLBACKS.SETTINGS_MANAGE_ADMINS) {
    await reloadAdminIds();
    const adminList = getAdminIds().join('\n');
    
    // Get current admin to tag
    const currentAdminTagId = await getPreorderAdminTag();
    let currentAdminTagUsername = null;
    if (currentAdminTagId) {
      currentAdminTagUsername = await getAdminUsernameById(bot, currentAdminTagId);
    }
    
    const text = menuTexts.manageAdminsText(userId, adminList, currentAdminTagId, currentAdminTagUsername);
    const keyboard = keyboards.manageAdminsKeyboard();
    await updateMenuMessage(bot, chatId, userId, text, keyboard);
    await bot.answerCallbackQuery(query.id);
    return true;
  }

  // Add admin
  if (data === CALLBACKS.MANAGE_ADD_ADMIN) {
    adminStates[userId] = STATES.ADD_ADMIN;
    const text = menuTexts.addAdminPromptText();
    const keyboard = keyboards.addAdminKeyboard();
    await updateMenuMessage(bot, chatId, userId, text, keyboard);
    await bot.answerCallbackQuery(query.id);
    return true;
  }

  // Delete admin
  if (data === CALLBACKS.MANAGE_DELETE_ADMIN) {
    const adminIdsList = getAdminIds();
    const text = menuTexts.deleteAdminSelectText();
    const keyboard = keyboards.adminListKeyboard(adminIdsList);
    await updateMenuMessage(bot, chatId, userId, text, keyboard);
    await bot.answerCallbackQuery(query.id);
    return true;
  }

  // Handle delete admin button clicks
  if (isCallbackType(data, CALLBACKS.DELETE_ADMIN_PREFIX)) {
    const adminIdToDelete = parseInt(extractCallbackValue(data, CALLBACKS.DELETE_ADMIN_PREFIX));
    const result = await deleteAdmin(adminIdToDelete);
    const keyboard = keyboards.addAdminKeyboard();
    await updateMenuMessage(bot, chatId, userId, result.message, keyboard);
    await bot.answerCallbackQuery(query.id);
    return true;
  }

  // Set admin to tag
  if (data === CALLBACKS.SETTINGS_SET_ADMIN_TAG) {
    await reloadAdminIds();
    const adminIdsList = getAdminIds();
    
    if (adminIdsList.length === 0) {
      const text = 'No admins available to set as tag admin.';
      const keyboard = keyboards.backToMainMenuKeyboard();
      await updateMenuMessage(bot, chatId, userId, text, keyboard);
      await bot.answerCallbackQuery(query.id);
      return true;
    }

    // Fetch admin data with usernames
    const adminList = await Promise.all(
      adminIdsList.map(async (adminId) => {
        const username = await getAdminUsernameById(bot, adminId);
        return { id: adminId, username };
      })
    );

    // Get current admin to tag
    const currentAdminTagId = await getPreorderAdminTag();
    
    const text = menuTexts.setAdminToTagText(currentAdminTagId, 
      adminList.find(a => a.id === currentAdminTagId)?.username);
    const keyboard = keyboards.selectAdminToTagKeyboard(adminList, currentAdminTagId);
    await updateMenuMessage(bot, chatId, userId, text, keyboard);
    await bot.answerCallbackQuery(query.id);
    return true;
  }

  // Handle set admin to tag button clicks
  if (isCallbackType(data, CALLBACKS.SET_ADMIN_TAG_PREFIX)) {
    const selectedAdminId = parseInt(extractCallbackValue(data, CALLBACKS.SET_ADMIN_TAG_PREFIX));
    
    // Save to Settings sheet B2
    const result = await writeToSheet(`Settings!B2`, [[selectedAdminId]]);
    
    if (result) {
      const username = await getAdminUsernameById(bot, selectedAdminId);
      const displayUsername = username ? `@${username}` : '';
      await bot.answerCallbackQuery(
        query.id,
        `✓ Admin to tag set to ${selectedAdminId} ${displayUsername}`,
        { show_alert: false }
      );
      
      // Refresh the menu
      const adminIdsList = getAdminIds();
      const adminList = await Promise.all(
        adminIdsList.map(async (adminId) => {
          const un = await getAdminUsernameById(bot, adminId);
          return { id: adminId, username: un };
        })
      );
      
      const text = menuTexts.setAdminToTagText(selectedAdminId, username);
      const keyboard = keyboards.selectAdminToTagKeyboard(adminList, selectedAdminId);
      await updateMenuMessage(bot, chatId, userId, text, keyboard);
    } else {
      await bot.answerCallbackQuery(
        query.id,
        '✗ Failed to set admin to tag',
        { show_alert: true }
      );
    }
    
    return true;
  }

  // Manage food items
  if (data === CALLBACKS.SETTINGS_MANAGE_FOODS) {
    const foodItems = await getFoodItems();
    const text = menuTexts.manageFoodItemsText(foodItems);
    const keyboard = keyboards.manageFoodItemsKeyboard();
    await updateMenuMessage(bot, chatId, userId, text, keyboard);
    await bot.answerCallbackQuery(query.id);
    return true;
  }

  // Add food item
  if (data === CALLBACKS.FOOD_ADD) {
    adminStates[userId] = 'add_food_item';
    const text = menuTexts.addFoodItemPromptText();
    const keyboard = keyboards.addFoodItemKeyboard();
    await updateMenuMessage(bot, chatId, userId, text, keyboard);
    await bot.answerCallbackQuery(query.id);
    return true;
  }

  // Delete food item
  if (data === CALLBACKS.FOOD_DELETE) {
    const foodItems = await getFoodItems();
    
    if (foodItems.length === 0) {
      const text = menuTexts.noFoodItemsText();
      const keyboard = keyboards.backToFoodMenuKeyboard();
      await updateMenuMessage(bot, chatId, userId, text, keyboard);
      await bot.answerCallbackQuery(query.id);
      return true;
    }

    const text = menuTexts.deleteFoodSelectText();
    const keyboard = keyboards.foodItemsDeleteKeyboard(foodItems);
    await updateMenuMessage(bot, chatId, userId, text, keyboard);
    await bot.answerCallbackQuery(query.id);
    return true;
  }

  // Handle delete food item button clicks
  if (isCallbackType(data, CALLBACKS.FOOD_DELETE_PREFIX)) {
    const deleteFoodPayload = extractCallbackValue(data, CALLBACKS.FOOD_DELETE_PREFIX);
    const [foodItemIdValue, foodToken] = deleteFoodPayload.split(':');
    const foodItemId = parseInt(foodItemIdValue);

    if (isNaN(foodItemId) || !foodToken) {
      await bot.answerCallbackQuery(query.id, 'This delete menu is outdated. Reopen Delete Food list.', { show_alert: true });
      return true;
    }

    const liveFoodItems = await getFoodItems();
    const liveFoodItem = liveFoodItems.find(item => item.id === foodItemId);

    if (!liveFoodItem || createCallbackItemToken(liveFoodItem.name) !== foodToken) {
      await bot.answerCallbackQuery(query.id, 'This delete button is outdated. Reopen Delete Food list.', { show_alert: true });
      return true;
    }

    const result = await deleteFoodItem(foodItemId);
    const keyboard = keyboards.backToFoodMenuKeyboard();
    await updateMenuMessage(bot, chatId, userId, result.message, keyboard);
    await bot.answerCallbackQuery(query.id);
    return true;
  }

  // Edit specific food item stock - show list to choose
  if (data === CALLBACKS.FOOD_EDIT_STOCK) {
    const foodItems = await getFoodItems();

    if (foodItems.length === 0) {
      const text = menuTexts.noFoodItemsText();
      const keyboard = keyboards.backToFoodMenuKeyboard();
      await updateMenuMessage(bot, chatId, userId, text, keyboard);
      await bot.answerCallbackQuery(query.id);
      return true;
    }

    const text = menuTexts.editSpecificStockText();
    const keyboard = keyboards.foodItemsEditStockKeyboard(foodItems);
    await updateMenuMessage(bot, chatId, userId, text, keyboard);
    await bot.answerCallbackQuery(query.id);
    return true;
  }

  // Handle edit stock button clicks for specific item
  if (isCallbackType(data, CALLBACKS.FOOD_EDIT_STOCK_PREFIX)) {
    const foodItemId = parseInt(extractCallbackValue(data, CALLBACKS.FOOD_EDIT_STOCK_PREFIX));
    adminStates[userId] = { mode: STATES.EDIT_FOOD_STOCK_SPECIFIC, foodItemId };
    
    const promptText = `📊 Enter new stock level for this food item:\n\nReply with a number (e.g., 10)`;
    const keyboard = keyboards.cancelStockEditKeyboard();
    await updateMenuMessage(bot, chatId, userId, promptText, keyboard);
    await bot.answerCallbackQuery(query.id);
    return true;
  }

  // Edit all food items stock - loop through each one
  if (data === CALLBACKS.FOOD_EDIT_ALL_STOCK) {
    const foodItems = await getFoodItems();

    if (foodItems.length === 0) {
      const text = menuTexts.noFoodItemsText();
      const keyboard = keyboards.backToFoodMenuKeyboard();
      await updateMenuMessage(bot, chatId, userId, text, keyboard);
      await bot.answerCallbackQuery(query.id);
      return true;
    }

    const firstItem = foodItems[0];
    const promptText = menuTexts.editStockPromptText(firstItem.name, firstItem.stock || 0, 1, foodItems.length);

    adminStates[userId] = { 
      mode: STATES.EDIT_ALL_FOOD_STOCK_LOOP,
      items: foodItems,
      currentIndex: 0
    };

    const keyboard = keyboards.cancelStockEditKeyboard();
    await updateMenuMessage(bot, chatId, userId, promptText, keyboard);
    await bot.answerCallbackQuery(query.id);
    return true;
  }

  // Manage halls
  if (data === CALLBACKS.SETTINGS_MANAGE_HALLS) {
    const halls = await getHalls();
    const text = menuTexts.manageHallsText(halls);
    const keyboard = keyboards.manageHallsKeyboard();
    await updateMenuMessage(bot, chatId, userId, text, keyboard);
    await bot.answerCallbackQuery(query.id);
    return true;
  }

  // Add hall
  if (data === CALLBACKS.HALL_ADD) {
    adminStates[userId] = STATES.ADD_HALL;
                                                                                                                                  const text = menuTexts.addHallPromptText();
    const keyboard = keyboards.addHallKeyboard();
    await updateMenuMessage(bot, chatId, userId, text, keyboard);
    await bot.answerCallbackQuery(query.id);
    return true;
  }

  // Delete hall
  if (data === CALLBACKS.HALL_DELETE) {
    const halls = await getHalls();
    
    if (halls.length === 0) {
      const text = 'No halls to delete.';
      const keyboard = keyboards.backToHallsKeyboard();
      await updateMenuMessage(bot, chatId, userId, text, keyboard);
      await bot.answerCallbackQuery(query.id);
      return true;
    }

    const text = menuTexts.deleteHallSelectText();
    const keyboard = keyboards.hallsDeleteKeyboard(halls);
    await updateMenuMessage(bot, chatId, userId, text, keyboard);
    await bot.answerCallbackQuery(query.id);
    return true;
  }

  // Handle delete hall button clicks
  if (isCallbackType(data, CALLBACKS.HALL_DELETE_PREFIX)) {
    const deleteHallPayload = extractCallbackValue(data, CALLBACKS.HALL_DELETE_PREFIX);
    const [hallIdValue, hallToken] = deleteHallPayload.split(':');
    const hallId = parseInt(hallIdValue);

    if (isNaN(hallId) || !hallToken) {
      await bot.answerCallbackQuery(query.id, 'This delete menu is outdated. Reopen Delete Hall list.', { show_alert: true });
      return true;
    }

    const liveHalls = await getHalls();
    const liveHall = liveHalls.find(item => item.id === hallId);

    if (!liveHall || createCallbackItemToken(liveHall.name) !== hallToken) {
      await bot.answerCallbackQuery(query.id, 'This delete button is outdated. Reopen Delete Hall list.', { show_alert: true });
      return true;
    }

    const result = await deleteHall(hallId);
    const keyboard = keyboards.backToHallsKeyboard();
    await updateMenuMessage(bot, chatId, userId, result.message, keyboard);
    await bot.answerCallbackQuery(query.id);
    return true;
  }

  // Back to main admin menu
  if (data === CALLBACKS.ADMIN_MENU_BACK) {
    await showMainAdminMenu(bot, chatId, userId);
    await bot.answerCallbackQuery(query.id);
    return true;
  }

  // Enter delivery mode
  if (data === CALLBACKS.SETTINGS_DELIVERY_MODE) {
    await showDeliveryModeMenu(bot, chatId, userId, userMenuMessages);
    await bot.answerCallbackQuery(query.id);
    return true;
  }

  if (isCallbackType(data, CALLBACKS.DELIVERY_MODE_POST_CHANNEL_PREFIX)) {
    const postPayload = extractCallbackValue(data, CALLBACKS.DELIVERY_MODE_POST_CHANNEL_PREFIX);
    const [postMode, hallIdValue] = postPayload.split(':');
    const hallId = parseInt(hallIdValue);

    if (isDeliveryPostInFlight) {
      await bot.answerCallbackQuery(query.id, 'A delivery update is already being posted.');
      return true;
    }

    isDeliveryPostInFlight = true;

    try {
      const halls = await getHalls();
      const hall = halls.find(item => item.id === hallId);

      if (!hall || !['preorder', 'coming', 'here', 'get-ready'].includes(postMode)) {
        await bot.answerCallbackQuery(query.id, 'Hall not found', { show_alert: true });
        return true;
      }

      if (!isExpectedNextHallToPost(halls, hallId, postMode)) {
        await refreshDeliveryModeMenus(bot, userMenuMessages);
        await bot.answerCallbackQuery(query.id, 'This button is outdated. Please use the latest delivery menu.', { show_alert: true });
        return true;
      }

      const dingoChannelId = process.env.DINGO_CHANNEL_ID || '';

      if (!dingoChannelId) {
        await bot.answerCallbackQuery(
          query.id,
          'DINGO_CHANNEL_ID is not set in the environment.',
          { show_alert: true }
        );
        return true;
      }

      const hallLabel = hall.shortName || hall.name;
      const preorderAdminId = await getPreorderAdminTag();
      const adminUsername = preorderAdminId ? await getAdminUsernameById(bot, preorderAdminId) : null;
      const botStartUrl = postMode === 'preorder' ? await getBotStartUrl(bot) : '';

      const postText = postMode === 'preorder'
        ? await buildPreorderMessageText(hallLabel, preorderAdminId, adminUsername)
        : postMode === 'get-ready'
        ? `Get ready, ${hallLabel}`
        : postMode === 'here'
        ? `${hallLabel}, we are here`
        : buildComingChannelMessage(hallLabel);

      let sentMsg;
      try {
        const sendOptions = postMode === 'preorder'
          ? {
            parse_mode: 'HTML',
            disable_web_page_preview: true,
            ...(buildPreorderStartButton(botStartUrl) ? { reply_markup: buildPreorderStartButton(botStartUrl) } : {}),
          }
          : {};

        sentMsg = await bot.sendMessage(dingoChannelId, postText, sendOptions);
      } catch (error) {
        console.error(`Failed to post Dingo channel update for ${hallLabel}:`, error.message);
        await bot.answerCallbackQuery(
          query.id,
          'Failed to post to the Dingo channel. Check the channel ID and bot permissions.',
          { show_alert: true }
        );
        return true;
      }

      const toDelete = getDingoMsgIdsToDelete(postMode);
      if (postMode === 'preorder') {
        recordPreorderPost(dingoChannelId, sentMsg.message_id);
        lastPreorderMessageText = postText;
        lastPreorderStartUrl = botStartUrl;
        startPreorderRefreshLoop(bot);
      } else {
        recordDingoPost(postMode, sentMsg.message_id);
      }
      for (const msgId of toDelete) {
        try { await bot.deleteMessage(dingoChannelId, msgId); } catch (_) {}
      }

      advanceNextHallToPost(halls, hallId, postMode);
      await refreshDeliveryModeMenus(bot, userMenuMessages);

      const callbackText = postMode === 'preorder'
        ? 'Posted preorder availability to Dingo channel.'
        : `Posted to Dingo channel: ${postText}`;

      if (postMode === 'here') {
        const hallOrders = getActiveOrdersByHall(hall.name);

        if (hallOrders.length > 0) {
          const serveOrdersText = `✅ ${hallLabel}, we are here\n\nTap each order when served:`;
          const serveOrdersKeyboard = buildHallServeOrdersKeyboard(hallOrders);
          await bot.sendMessage(chatId, serveOrdersText, { reply_markup: serveOrdersKeyboard });
        }
      }

      await bot.answerCallbackQuery(query.id, callbackText);
      return true;
    } finally {
      isDeliveryPostInFlight = false;
    }
  }

  if (isCallbackType(data, CALLBACKS.DELIVERY_MODE_BLOCK_HALL_PREFIX)) {
    const hallId = parseInt(extractCallbackValue(data, CALLBACKS.DELIVERY_MODE_BLOCK_HALL_PREFIX));
    const halls = await getHalls();
    const hall = halls.find(item => item.id === hallId);

    if (!hall) {
      await bot.answerCallbackQuery(query.id, 'Hall not found', { show_alert: true });
      return true;
    }

    const didBlockHall = blockHall(hall.name);

    if (!didBlockHall) {
      await bot.answerCallbackQuery(query.id, `${hall.name} is already blocked`, { show_alert: true });
      return true;
    }

    await refreshPreorderChannelMessage(bot);

    await refreshDeliveryModeMenus(bot, userMenuMessages);
    await bot.answerCallbackQuery(query.id, `Blocked ${hall.name}`);
    return true;
  }

  if (data === CALLBACKS.DELIVERY_MODE_REVERT_BLOCK) {
    const currentMenuMessageId = userMenuMessages[userId];

    if (!currentMenuMessageId || currentMenuMessageId !== messageId) {
      await bot.answerCallbackQuery(query.id, 'This delivery menu is outdated. Please use the latest menu.', { show_alert: true });
      return true;
    }

    const revertedHall = revertLastBlockedHall();

    if (!revertedHall) {
      await bot.answerCallbackQuery(query.id, 'No blocked hall to revert', { show_alert: true });
      return true;
    }

    await refreshPreorderChannelMessage(bot);
    await refreshDeliveryModeMenus(bot, userMenuMessages);
    await bot.answerCallbackQuery(query.id, `Reverted ${revertedHall}`);
    return true;
  }

  if (isCallbackType(data, CALLBACKS.DELIVERY_MODE_SERVE_ORDER_PREFIX)) {
    const orderId = parseInt(extractCallbackValue(data, CALLBACKS.DELIVERY_MODE_SERVE_ORDER_PREFIX));

    if (isNaN(orderId)) {
      await bot.answerCallbackQuery(query.id, 'Invalid order', { show_alert: true });
      return true;
    }

    const order = getPendingOrder(orderId);
    if (!order) {
      await bot.answerCallbackQuery(query.id, 'Order not found', { show_alert: true });
      return true;
    }

    const servedOrder = markOrderServed(orderId, userId);
    if (!servedOrder) {
      await bot.answerCallbackQuery(query.id, 'Order is already served or no longer active.');
      return true;
    }

    // Notify the customer that their order has been delivered
    try {
      const tagAdminId = await getPreorderAdminTag();
      const tagUsername = tagAdminId ? await getAdminUsernameById(bot, tagAdminId) : null;
      const contactPart = tagUsername ? `@${tagUsername}` : 'the admin';
      await bot.sendMessage(
        servedOrder.chatId,
        `✅ Your order #${servedOrder.id} has been delivered/dropped off!\n\nFor any issues, please contact ${contactPart}.`
      );
    } catch (notifyError) {
      console.error(`Failed to notify customer for served order #${orderId}:`, notifyError.message);
    }

    const keyboard = query.message && query.message.reply_markup && query.message.reply_markup.inline_keyboard
      ? query.message.reply_markup.inline_keyboard
      : [];

    const servedCallbackData = `${CALLBACKS.DELIVERY_MODE_SERVE_ORDER_PREFIX}${orderId}`;
    const updatedKeyboard = keyboard
      .map(row => row.filter(button => button.callback_data !== servedCallbackData))
      .filter(row => row.length > 0);

    if (updatedKeyboard.length === 0) {
      const currentText = (query.message && query.message.text) || '✅ Orders for this hall';
      await editMessageTextSafely(bot, `${currentText}\n\n✅ All orders in this list have been served.`, {
        chat_id: chatId,
        message_id: messageId,
      });
    } else {
      await bot.editMessageReplyMarkup(
        { inline_keyboard: updatedKeyboard },
        {
          chat_id: chatId,
          message_id: messageId,
        }
      );
    }

    await bot.answerCallbackQuery(query.id, `Order #${orderId} marked as served.`);
    return true;
  }

  if (data === CALLBACKS.DELIVERY_MODE_FINISH) {
    await bot.answerCallbackQuery(query.id);

    stopPreorderRefreshLoop();
    const dingoChannelId = process.env.DINGO_CHANNEL_ID || '';
    const trackedDingoMessageIds = consumeTrackedDingoMessageIds();

    if (dingoChannelId && trackedDingoMessageIds.length) {
      for (const messageId of trackedDingoMessageIds) {
        try {
          await bot.deleteMessage(dingoChannelId, messageId);
        } catch (_) {}
      }
    }

    const currentMenuMessageId = userMenuMessages[userId];
    if (currentMenuMessageId) {
      try {
        await bot.deleteMessage(chatId, currentMenuMessageId);
      } catch (_) {}
      delete userMenuMessages[userId];
    }

    await bot.sendMessage(
      chatId,
      '✅ Delivery finished. Tap below to reset halls when you are ready.',
      {
        reply_markup: {
          inline_keyboard: [[
            { text: '🔄 Reset Halls', callback_data: CALLBACKS.DELIVERY_MODE_RESET_HALLS },
          ]],
        },
      }
    );
    await showMainAdminMenu(bot, chatId, userId);
    return true;
  }

  if (data === CALLBACKS.DELIVERY_MODE_RESET_HALLS) {
    clearBlockedHalls();
    await refreshDeliveryModeMenus(bot, userMenuMessages);
    await bot.answerCallbackQuery(query.id, '✅ Halls have been reset.');
    await bot.sendMessage(chatId, '✅ Halls have been reset. Orders are now available to be placed by any halls.');
    return true;
  }

  // Back from delivery mode to admin menu
  if (data === CALLBACKS.DELIVERY_MODE_BACK) {
    await showMainAdminMenu(bot, chatId, userId);
    await bot.answerCallbackQuery(query.id);
    return true;
  }

  return false;
}

module.exports = {
  handleAdminCommand,
  handleAdminCallback,
  adminStates,
  userMenuMessages,
};