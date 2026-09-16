const { isAdmin, getHalls, getFoodItems, updateFoodItemStocksBatch, getAdminIds } = require('../services/googleSheets');
const { CALLBACKS } = require('../config/constants');
const { hasPreorderPost } = require('./deliveryMode');
const { editMessageTextSafely } = require('../utils/telegramEdits');
const {
  createPendingOrder,
  getPendingOrder,
  getAwaitingPaymentOrderId,
  clearAwaitingPayment,
  isHallBlocked,
} = require('../services/orderStore');

// Track user's selected hall
const userHalls = {};

// Track user's cart items: { [userId]: { [foodId]: quantity } }
const userCarts = {};

const USER_CALLBACKS = {
  SELECT_HALL_PREFIX: 'user_select_hall_',
  ADD_FOOD_PREFIX: 'user_add_food_',
  CONFIRM_ORDER: 'user_confirm_order',
  CLEAR_CART: 'user_clear_cart',
};

const ORDERING_NOT_OPEN_TEXT = '⏳ Ordering is not open yet. Please wait for preorder announcement.';
const pendingConfirmByUser = {};
let confirmOrderQueue = Promise.resolve();

function runInConfirmCriticalSection(task) {
  const queuedTask = confirmOrderQueue.then(task);
  confirmOrderQueue = queuedTask.catch(() => {});
  return queuedTask;
}

async function answerCallbackSafely(bot, callbackQueryId, text, options = {}) {
  try {
    await bot.answerCallbackQuery(callbackQueryId, text, options);
    return true;
  } catch (error) {
    const errorMessage = error && error.message ? error.message : '';

    if (errorMessage.includes('query is too old') || errorMessage.includes('query ID is invalid')) {
      console.warn(`Skipped expired callback query ${callbackQueryId}: ${errorMessage}`);
      return false;
    }

    throw error;
  }
}

async function answerCallbackOrSendMessage(bot, query, text, options = {}) {
  const didAnswerCallback = await answerCallbackSafely(bot, query.id, text, options);

  if (!didAnswerCallback) {
    await bot.sendMessage(query.message.chat.id, text);
  }
}

function isOrderingOpen() {
  return hasPreorderPost();
}

function getUserCart(userId) {
  if (!userCarts[userId]) {
    userCarts[userId] = {};
  }
  return userCarts[userId];
}

function buildOrderText(hallName, foodItems, cart) {
  let total = 0;
  let cartLines = '';

  foodItems.forEach(item => {
    const quantity = cart[item.id] || 0;
    if (quantity > 0) {
      const lineTotal = quantity * item.price;
      total += lineTotal;
      cartLines += `• ${item.name} x${quantity} = $${lineTotal.toFixed(2)}\n`;
    }
  });

  if (!cartLines) {
    cartLines = 'No items yet.';
  }

  return `🏢 Hall: ${hallName}\n\n🛒 Cart:\n${cartLines}\n💰 Total: $${total.toFixed(2)}\n\nTap a food item to add:`;
}

function buildFoodKeyboard(foodItems, cart) {
  const buttons = foodItems.map(item => {
    return [{
      text: `${item.name} ($${item.price})`,
      callback_data: `${USER_CALLBACKS.ADD_FOOD_PREFIX}${item.id}`,
    }];
  });

  buttons.push([{ text: '✅ Confirm Order', callback_data: USER_CALLBACKS.CONFIRM_ORDER }]);
  buttons.push([{ text: '🗑 Clear Cart', callback_data: USER_CALLBACKS.CLEAR_CART }]);

  return { inline_keyboard: buttons };
}

async function showOrderScreen(bot, chatId, userId, messageId) {
  if (!isOrderingOpen()) {
    delete userHalls[userId];
    delete userCarts[userId];

    await editMessageTextSafely(bot, ORDERING_NOT_OPEN_TEXT, {
      chat_id: chatId,
      message_id: messageId,
    });
    return;
  }

  const hall = userHalls[userId];

  if (!hall || isHallBlocked(hall.name)) {
    delete userHalls[userId];
    delete userCarts[userId];

    await editMessageTextSafely(bot, '⛔ Ordering for your hall is closed.', {
      chat_id: chatId,
      message_id: messageId,
    });
    return;
  }

  const foodItems = await getFoodItems();
  const cart = getUserCart(userId);

  const text = buildOrderText(hall.name, foodItems, cart);
  const keyboard = buildFoodKeyboard(foodItems, cart);

  await editMessageTextSafely(bot, text, {
    chat_id: chatId,
    message_id: messageId,
    reply_markup: keyboard,
  });
}

/**
 * Handle user commands
 */
async function handleUserCommand(bot, msg) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const userMessage = msg.text;

  // /start command (also handles deep links like /start order)
  if (userMessage && (userMessage === '/start' || userMessage.startsWith('/start '))) {
    // Reset hall/cart for a fresh order flow
    delete userHalls[userId];
    delete userCarts[userId];

    if (!isOrderingOpen()) {
      await bot.sendMessage(chatId, ORDERING_NOT_OPEN_TEXT);
      return true;
    }

    const halls = (await getHalls()).filter(hall => !isHallBlocked(hall.name));
    
    if (halls.length === 0) {
      await bot.sendMessage(chatId, 'No halls available for ordering right now. Please contact an admin.');
      return true;
    }

    const startText = `🏢 Welcome! Please select your hall:\n\nNote: If your usual pickup location is not listed, ordering for that hall has already closed.`;
    
    // Create button for each hall
    const hallButtons = halls.map(hall => [
      { text: `${hall.name}`, callback_data: `${USER_CALLBACKS.SELECT_HALL_PREFIX}${hall.id}` }
    ]);

    const keyboard = { inline_keyboard: hallButtons };
    await bot.sendMessage(chatId, startText, { reply_markup: keyboard });
    return true;
  }

  // /checkteleid command
  if (userMessage === '/checkteleid') {
    const firstName = msg.from.first_name || 'Unknown';
    const username = msg.from.username ? `@${msg.from.username}` : 'No username';
    const adminStatus = isAdmin(userId) ? '👑 ADMIN' : 'User';

    await bot.sendMessage(chatId, `Your Telegram ID: ${userId}\nName: ${firstName}\nUsername: ${username}\nStatus: ${adminStatus}`);
    return true;
  }

  return false;
}

/**
 * Echo the user's message
 */
async function echoMessage(bot, msg) {
  const chatId = msg.chat.id;
  const userMessage = msg.text;
  await bot.sendMessage(chatId, `You said: ${userMessage}`);
}

/**
 * Handle user callback queries (button clicks)
 */
async function handleUserCallback(bot, query) {
  const chatId = query.message.chat.id;
  const userId = query.from.id;
  const data = query.data;

  // Hall selection
  if (data.startsWith(USER_CALLBACKS.SELECT_HALL_PREFIX)) {
    const hallId = parseInt(data.substring(USER_CALLBACKS.SELECT_HALL_PREFIX.length));
    const halls = await getHalls();
    const selectedHall = halls.find(h => h.id === hallId);

    if (!selectedHall) {
      await bot.answerCallbackQuery(query.id, 'Hall not found', { show_alert: true });
      return false;
    }

    if (!isOrderingOpen()) {
      await bot.answerCallbackQuery(query.id, 'Ordering is not open yet.', { show_alert: true });
      return true;
    }

    if (isHallBlocked(selectedHall.name)) {
      await bot.answerCallbackQuery(query.id, `Ordering for ${selectedHall.name} is closed`, { show_alert: true });
      return true;
    }

    userHalls[userId] = selectedHall;
    getUserCart(userId);

    await showOrderScreen(bot, chatId, userId, query.message.message_id);
    await bot.answerCallbackQuery(query.id, `Hall: ${selectedHall.name}`);
    return true;
  }

  // Add food item to cart
  if (data.startsWith(USER_CALLBACKS.ADD_FOOD_PREFIX)) {
    const foodId = parseInt(data.substring(USER_CALLBACKS.ADD_FOOD_PREFIX.length));
    const selectedHall = userHalls[userId];

    if (!selectedHall) {
      await bot.answerCallbackQuery(query.id, 'Please select a hall first using /start', { show_alert: true });
      return true;
    }

    if (!isOrderingOpen()) {
      await bot.answerCallbackQuery(query.id, 'Ordering is not open yet.', { show_alert: true });
      await showOrderScreen(bot, chatId, userId, query.message.message_id);
      return true;
    }

    if (isHallBlocked(selectedHall.name)) {
      await bot.answerCallbackQuery(query.id, `Ordering for ${selectedHall.name} is closed`, { show_alert: true });
      await showOrderScreen(bot, chatId, userId, query.message.message_id);
      return true;
    }

    const foodItems = await getFoodItems();
    const item = foodItems.find(food => food.id === foodId);

    if (!item) {
      await bot.answerCallbackQuery(query.id, 'Food item not found', { show_alert: true });
      return true;
    }

    const cart = getUserCart(userId);
    const currentQuantity = cart[item.id] || 0;

    if (currentQuantity >= (item.stock || 0)) {
      await bot.answerCallbackQuery(query.id);
      await bot.sendMessage(chatId, `❌ Sorry, there is no more stock for ${item.name}.`);
      return true;
    }

    cart[item.id] = currentQuantity + 1;

    await showOrderScreen(bot, chatId, userId, query.message.message_id);
    await bot.answerCallbackQuery(query.id, `Added: ${item.name}`);
    return true;
  }

  // Confirm order and deduct stock in sheet
  if (data === USER_CALLBACKS.CONFIRM_ORDER) {
    if (pendingConfirmByUser[userId]) {
      await answerCallbackSafely(bot, query.id, 'Processing your order...');
      return true;
    }

    pendingConfirmByUser[userId] = true;

    try {
      const reservationResult = await runInConfirmCriticalSection(async () => {
        const selectedHall = userHalls[userId];

        if (!selectedHall) {
          await answerCallbackOrSendMessage(bot, query, 'Please select a hall first using /start', { show_alert: true });
          return null;
        }

        if (!isOrderingOpen()) {
          await answerCallbackOrSendMessage(bot, query, 'Ordering is not open yet.', { show_alert: true });
          await showOrderScreen(bot, chatId, userId, query.message.message_id);
          return null;
        }

        if (isHallBlocked(selectedHall.name)) {
          await answerCallbackOrSendMessage(bot, query, `Ordering for ${selectedHall.name} is closed`, { show_alert: true });
          await showOrderScreen(bot, chatId, userId, query.message.message_id);
          return null;
        }

        const cart = getUserCart(userId);
        const cartEntries = Object.entries(cart).filter(([, quantity]) => quantity > 0);

        if (cartEntries.length === 0) {
          await answerCallbackOrSendMessage(bot, query, 'Your cart is empty.', { show_alert: true });
          return null;
        }

        const latestFoodItems = await getFoodItems();
        const stockUpdates = [];

        // Validate current stock before deducting
        for (const [foodIdKey, quantity] of cartEntries) {
          const foodId = parseInt(foodIdKey);
          const item = latestFoodItems.find(food => food.id === foodId);

          if (!item || (item.stock || 0) < quantity) {
            userCarts[userId] = {};
            await bot.answerCallbackQuery(query.id);
            await bot.sendMessage(chatId, '❌ An error has occurred. Your cart has been cleared. Please restart your order by typing /start.');
            return null;
          }

          stockUpdates.push({
            rowId: item.id,
            newStock: (item.stock || 0) - quantity,
          });
        }

        const updateResult = await updateFoodItemStocksBatch(stockUpdates);
        if (!updateResult.success) {
          userCarts[userId] = {};
          await bot.answerCallbackQuery(query.id);
          await bot.sendMessage(chatId, '❌ An error has occurred. Your cart has been cleared. Please restart your order by typing /start.');
          return null;
        }

        // Build order summary and calculate total from confirmed snapshot
        const orderItems = [];
        let total = 0;
        let summaryLines = '';

        for (const [foodIdKey, quantity] of cartEntries) {
          const foodId = parseInt(foodIdKey);
          const item = latestFoodItems.find(food => food.id === foodId);

          if (!item) {
            continue;
          }

          const lineTotal = (item.price || 0) * quantity;
          total += lineTotal;
          summaryLines += `• ${item.name} x${quantity} = $${lineTotal.toFixed(2)}\n`;
          orderItems.push({
            id: item.id,
            name: item.name,
            price: item.price || 0,
            quantity,
          });
        }

        if (!summaryLines) {
          summaryLines = 'No items';
        }

        const order = createPendingOrder({
          userId,
          userName: query.from.first_name || 'Unknown',
          username: query.from.username || null,
          chatId,
          hallName: selectedHall.name,
          items: orderItems,
          total,
        });

        // Clear the cart while still inside the critical section so repeat clicks
        // cannot recreate the same reservation while follow-up messages are sent.
        userCarts[userId] = {};
        await answerCallbackSafely(bot, query.id, 'Processing your order...');

        return {
          order,
          selectedHall,
          summaryLines,
          total,
        };
      });

      if (!reservationResult) {
        return true;
      }

      const { order, selectedHall, summaryLines, total } = reservationResult;

      try {
        await bot.deleteMessage(chatId, query.message.message_id);
      } catch (error) {
        console.error('Error deleting cart message:', error.message);
      }

      const userOrderSummary = `✅ We are now processing your order.\nPlease wait and be ready to make payment shortly.\n\n🧾 Order #${order.id}\n🏢 Hall: ${selectedHall.name}\n\n🧾 Order Summary:\n${summaryLines}\n💰 Total: $${total.toFixed(2)}`;
      await bot.sendMessage(chatId, userOrderSummary);

      // Forward order to all admins after the stock-critical section completes.
      const adminIds = getAdminIds();
      const userLabel = query.from.username
        ? `@${query.from.username}`
        : `${query.from.first_name || 'Unknown'} (${userId})`;
      const adminOrderText = `🛎️ New Order #${order.id}\n👤 User: ${userLabel}\n🏢 Hall: ${selectedHall.name}\n\n🧾 Order Summary:\n${summaryLines}\n💰 Total: $${total.toFixed(2)}`;
      const adminKeyboard = {
        inline_keyboard: [[
          { text: '✅ Confirm', callback_data: `${CALLBACKS.ORDER_CONFIRM_PREFIX}${order.id}` },
          { text: '❌ Reject', callback_data: `${CALLBACKS.ORDER_REJECT_PREFIX}${order.id}` },
        ]],
      };

      for (const adminId of adminIds) {
        try {
          await bot.sendMessage(adminId, adminOrderText, { reply_markup: adminKeyboard });
        } catch (error) {
          console.error(`Failed to send order #${order.id} to admin ${adminId}:`, error.message);
        }
      }
    } finally {
      delete pendingConfirmByUser[userId];
    }

    return true;
  }

  // Clear cart
  if (data === USER_CALLBACKS.CLEAR_CART) {
    const selectedHall = userHalls[userId];

    if (!selectedHall) {
      await bot.answerCallbackQuery(query.id, 'Please select a hall first using /start', { show_alert: true });
      return true;
    }

    if (!isOrderingOpen()) {
      await bot.answerCallbackQuery(query.id, 'Ordering is not open yet.', { show_alert: true });
      await showOrderScreen(bot, chatId, userId, query.message.message_id);
      return true;
    }

    const cart = getUserCart(userId);
    const hasItems = Object.values(cart).some(quantity => quantity > 0);

    if (!hasItems) {
      await bot.answerCallbackQuery(query.id, 'Cart is already empty.');
      return true;
    }

    userCarts[userId] = {};
    await showOrderScreen(bot, chatId, userId, query.message.message_id);
    await bot.answerCallbackQuery(query.id, 'Cart cleared');
    return true;
  }

  return false;
}

/**
 * Handle payment screenshot sent by the user
 */
async function handleUserPhoto(bot, msg) {
  const userId = msg.from.id;
  const chatId = msg.chat.id;

  const orderId = getAwaitingPaymentOrderId(userId);
  if (!orderId) return false;

  const order = getPendingOrder(orderId);
  if (!order || order.status !== 'confirmed') {
    clearAwaitingPayment(userId);
    return false;
  }

  // Use the highest-resolution photo
  const photo = msg.photo[msg.photo.length - 1];
  const fileId = photo.file_id;

  const itemsSummary = (order.items || [])
    .map(item => `• ${item.name} x${item.quantity} = $${(item.price * item.quantity).toFixed(2)}`)
    .join('\n');
  const userLabel = order.username
    ? `@${order.username}`
    : `${order.userName || 'Unknown'} (${userId})`;

  const caption =
    `💳 Payment Screenshot — Order #${order.id}\n` +
    `👤 User: ${userLabel}\n` +
    `🏢 Hall: ${order.hallName}\n\n` +
    `🧾 Items:\n${itemsSummary}\n\n` +
    `💰 Total: $${Number(order.total).toFixed(2)}`;

  const keyboard = {
    inline_keyboard: [[
      { text: '✅ Accept Payment', callback_data: `${CALLBACKS.PAYMENT_ACCEPT_PREFIX}${order.id}` },
      { text: '❌ Reject Payment', callback_data: `${CALLBACKS.PAYMENT_REJECT_PREFIX}${order.id}` },
    ]],
  };

  clearAwaitingPayment(userId);

  const adminIds = getAdminIds();
  for (const adminId of adminIds) {
    try {
      await bot.sendPhoto(adminId, fileId, { caption, reply_markup: keyboard });
    } catch (error) {
      console.error(`Failed to forward payment screenshot to admin ${adminId}:`, error.message);
    }
  }

  await bot.sendMessage(chatId, `📨 Payment screenshot received for Order #${order.id}. Please wait for confirmation.`);
  return true;
}

/**
 * Get user's selected hall
 */
function getUserHall(userId) {
  return userHalls[userId] || null;
}

module.exports = {
  handleUserCommand,
  echoMessage,
  handleUserCallback,
  handleUserPhoto,
  getUserHall,
  userHalls,
  userCarts,
};