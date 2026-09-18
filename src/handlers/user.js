const { isAdmin, getHalls, getFoodItems, updateFoodItemStocksBatch, getAdminIds } = require('../services/googleSheets');
const { CALLBACKS } = require('../config/constants');
const { hasPreorderPost } = require('./deliveryMode');
const { editMessageTextSafely } = require('../utils/telegramEdits');
const orderStore = require('../services/orderStore');
const repo = require('../services/orderRepository');
const cartStore = require('../services/cartStore');
const stateStore = require('../services/stateStore');
const paymentVerifier = require('../services/paymentVerifier');
const orderActions = require('../services/orderActions');
const { isImageDocument } = require('../utils/telegramFiles');
const { config } = require('../config');
const { toCents, formatCents } = require('../utils/money');
const { formatSgtFriendly } = require('../utils/time');
const { log } = require('../utils/logger');

const STATUS = repo.STATUS;

const USER_CALLBACKS = {
  SELECT_HALL_PREFIX: 'user_select_hall_',
  ADD_FOOD_PREFIX: 'user_add_food_',
  CONFIRM_ORDER: 'user_confirm_order',
  CLEAR_CART: 'user_clear_cart',
  // Distinct prefix so admin and order callbacks cannot collide.
  ORDERS_PAGE_PREFIX: 'uorders_page_',
};

const ORDERING_NOT_OPEN_TEXT = '⏳ Ordering is not open yet. Please wait for preorder announcement.';
const ORDERS_PAGE_SIZE = 5;

/** Friendly labels for the customer's own order history. */
const STATUS_LABELS = {
  [STATUS.PENDING_ADMIN_CONFIRMATION]: '🕐 Awaiting admin confirmation',
  [STATUS.AWAITING_PAYMENT]: '💳 Awaiting payment',
  [STATUS.VERIFYING_PAYMENT]: '🔍 Verifying payment',
  [STATUS.PAYMENT_FLAGGED]: '👀 Payment under review',
  [STATUS.PAID]: '✅ Paid',
  [STATUS.SERVED]: '🍽️ Served / Delivered',
  [STATUS.REJECTED]: '❌ Rejected',
  [STATUS.CANCELLED]: '🚫 Cancelled',
  [STATUS.EXPIRED]: '⌛ Expired',
};

async function isOrderingOpen() {
  return hasPreorderPost();
}


// --- Phone number collection ---------------------------------------------------

/**
 * Staff at a hall need a way to identify a customer that survives them
 * closing the app - a Telegram handle doesn't. Collected once, the first
 * time (or the first time since this shipped) a customer confirms an order.
 *
 * Kept permissive rather than Singapore-only: NTU has a lot of international
 * students, and rejecting a real foreign number would just block an order for
 * no benefit. Strips everything but digits and accepts a plausible length.
 */
function normalizePhoneNumber(text) {
  const digits = String(text || '').replace(/\D/g, '');
  return digits.length >= 7 && digits.length <= 15 ? digits : null;
}

async function requestPhoneNumber(bot, chatId, userId) {
  await stateStore.set(stateStore.KEYS.awaitingPhoneNumber(userId), true, { ttlMs: 30 * 60 * 1000 });

  await bot.sendMessage(
    chatId,
    '📱 Before we can confirm your order, we need a contact number so staff can reach you at the hall.\n\n'
    + 'Please reply with your phone number (e.g. 91234567), then tap ✅ Confirm Order again.'
  );
}

async function handlePhoneNumberReply(bot, msg) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const phoneNumber = normalizePhoneNumber(msg.text);

  if (!phoneNumber) {
    await bot.sendMessage(
      chatId,
      "❌ That doesn't look like a valid phone number. Please reply with just the digits, e.g. 91234567."
    );
    return true;
  }

  try {
    await repo.upsertCustomer({
      telegramUserId: userId,
      username: msg.from.username || null,
      firstName: msg.from.first_name || null,
      lastName: null,
      phoneNumber,
    });
  } catch (error) {
    // Left uncaught, this silently loops the customer forever: the state
    // below never clears, so every next message re-triggers this same
    // prompt with no visible error at all. Likeliest cause is
    // customers.phone_number missing from the database - migration
    // 0006_customer_phone_number.sql not applied yet.
    log('error', 'phone_number_save_failed', { error: error.message });
    await bot.sendMessage(
      chatId,
      '❌ Something went wrong saving that. Please try again in a moment, or contact an admin if this keeps happening.'
    );
    return true;
  }

  await stateStore.remove(stateStore.KEYS.awaitingPhoneNumber(userId));
  await bot.sendMessage(chatId, '✅ Thanks! Now tap ✅ Confirm Order again to complete your order.');
  return true;
}

async function answerCallbackSafely(bot, callbackQueryId, text, options = {}) {
  try {
    await bot.answerCallbackQuery(callbackQueryId, { ...options, text });
    return true;
  } catch (error) {
    const message = error && error.message ? error.message : '';

    // Telegram expires callback queries after a couple of minutes. A slow
    // verification can outlive one, and that must not crash the handler.
    if (message.includes('query is too old') || message.includes('query ID is invalid')) {
      return false;
    }

    throw error;
  }
}

async function answerOrSend(bot, query, text, options = {}) {
  const answered = await answerCallbackSafely(bot, query.id, text, options);

  if (!answered) {
    await bot.sendMessage(query.message.chat.id, text);
  }
}


// --- Order screen ------------------------------------------------------------

function buildOrderText(hallName, foodItems, cart) {
  let totalCents = 0;
  let lines = '';

  for (const item of foodItems) {
    const quantity = cartStore.getQuantity(cart, item.id);

    if (quantity > 0) {
      const unitCents = toCents(item.price) || 0;
      const lineCents = unitCents * quantity;
      totalCents += lineCents;
      lines += `• ${item.name} x${quantity} = ${formatCents(lineCents)}\n`;
    }
  }

  return `🏢 Hall: ${hallName}\n\n🛒 Cart:\n${lines || 'No items yet.'}\n`
    + `💰 Total: ${formatCents(totalCents)}\n\nTap a food item to add:`;
}

function buildFoodKeyboard(foodItems) {
  const buttons = foodItems.map(item => [{
    text: `${item.name} (${formatCents(toCents(item.price) || 0)})`,
    callback_data: `${USER_CALLBACKS.ADD_FOOD_PREFIX}${item.id}`,
  }]);

  buttons.push([{ text: '✅ Confirm Order', callback_data: USER_CALLBACKS.CONFIRM_ORDER }]);
  buttons.push([{ text: '🗑 Clear Cart', callback_data: USER_CALLBACKS.CLEAR_CART }]);

  return { inline_keyboard: buttons };
}

async function showOrderScreen(bot, chatId, userId, messageId) {
  if (!await isOrderingOpen()) {
    await cartStore.clearCart(userId);
    await editMessageTextSafely(bot, ORDERING_NOT_OPEN_TEXT, { chat_id: chatId, message_id: messageId });
    return;
  }

  const cart = await cartStore.getCart(userId);
  const blocked = await orderStore.loadBlockedHalls();

  if (!cart.hallName || blocked.isBlocked(cart.hallName)) {
    await cartStore.clearCart(userId);
    await editMessageTextSafely(bot, '⛔ Ordering for your hall is closed.', {
      chat_id: chatId,
      message_id: messageId,
    });
    return;
  }

  const foodItems = await getFoodItems();

  await editMessageTextSafely(bot, buildOrderText(cart.hallName, foodItems, cart), {
    chat_id: chatId,
    message_id: messageId,
    reply_markup: buildFoodKeyboard(foodItems),
  });
}


// --- Commands ----------------------------------------------------------------

async function handleUserCommand(bot, msg) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const text = msg.text;

  if (!text) {
    return false;
  }

  // A slash command always wins over a pending phone-number prompt, same as
  // the admin input-state pattern - typing /start mid-prompt should not get
  // swallowed as a (garbage) phone number attempt.
  const isCommand = text.startsWith('/');

  if (!isCommand && await stateStore.get(stateStore.KEYS.awaitingPhoneNumber(userId))) {
    return handlePhoneNumberReply(bot, msg);
  }

  // Handles the /start order deep link from the channel post too.
  if (text === '/start' || text.startsWith('/start ')) {
    await cartStore.clearCart(userId);

    if (!await isOrderingOpen()) {
      await bot.sendMessage(chatId, ORDERING_NOT_OPEN_TEXT);
      return true;
    }

    const blocked = await orderStore.loadBlockedHalls();
    const halls = (await getHalls()).filter(hall => !blocked.isBlocked(hall.name));

    if (halls.length === 0) {
      await bot.sendMessage(chatId, 'No halls available for ordering right now. Please contact an admin.');
      return true;
    }

    await bot.sendMessage(
      chatId,
      '🏢 Welcome! Please select your hall:\n\n'
      + 'Note: If your usual pickup location is not listed, ordering for that hall has already closed.',
      {
        reply_markup: {
          inline_keyboard: halls.map(hall => [
            { text: hall.name, callback_data: `${USER_CALLBACKS.SELECT_HALL_PREFIX}${hall.id}` },
          ]),
        },
      }
    );
    return true;
  }

  if (text === '/checkteleid') {
    const username = msg.from.username ? `@${msg.from.username}` : 'No username';
    await bot.sendMessage(
      chatId,
      `Your Telegram ID: ${userId}\nName: ${msg.from.first_name || 'Unknown'}\n`
      + `Username: ${username}\nStatus: ${isAdmin(userId) ? '👑 ADMIN' : 'User'}`
    );
    return true;
  }

  if (text === '/orders') {
    await sendOrdersPage(bot, chatId, userId, 0);
    return true;
  }

  return false;
}

/**
 * Replaces the original `You said: ...` echo, which made the bot look broken
 * when someone typed anything it did not recognise.
 */
async function sendFallbackHint(bot, msg) {
  if (!msg.text || msg.text.startsWith('/')) {
    // Unknown slash commands get no reply rather than a confusing echo.
    return;
  }

  await bot.sendMessage(
    msg.chat.id,
    'Tap /start to place an order, or /orders to see your past orders.'
  );
}


// --- /orders -----------------------------------------------------------------

function buildOrdersPageText(orders, page, total) {
  const pageCount = Math.max(1, Math.ceil(total / ORDERS_PAGE_SIZE));

  const blocks = orders.map(row => {
    const order = orderStore.toOrder(row);

    const items = order.items.length
      ? order.items.map(item => `   • ${item.name} x${item.quantity}`).join('\n')
      : '   • (no items)';

    const lines = [
      `🧾 ${order.code}`,
      `   ${formatSgtFriendly(order.createdAt)}`,
      `   🏢 ${order.hallName}`,
      items,
      `   💰 ${formatCents(order.totalCents)}`,
      `   ${STATUS_LABELS[order.status] || order.status}`,
    ];

    // Delivery fields are nullable and unused today, shown only if ever added.
    if (row.recipient_name || row.delivery_address) {
      lines.splice(3, 0, `   📦 ${[row.recipient_name, row.delivery_address, row.postal_code].filter(Boolean).join(', ')}`);
    }

    if (order.status === STATUS.REJECTED && order.rejectionReason) {
      lines.push(`   ↳ Reason: ${order.rejectionReason}`);
    }

    return lines.join('\n');
  });

  return `📋 Your orders (page ${page + 1} of ${pageCount})\n\n${blocks.join('\n\n')}`;
}

function buildOrdersKeyboard(page, total) {
  const pageCount = Math.max(1, Math.ceil(total / ORDERS_PAGE_SIZE));
  const row = [];

  if (page > 0) {
    row.push({ text: '◀ Previous', callback_data: `${USER_CALLBACKS.ORDERS_PAGE_PREFIX}${page - 1}` });
  }

  if (page < pageCount - 1) {
    row.push({ text: 'Next ▶', callback_data: `${USER_CALLBACKS.ORDERS_PAGE_PREFIX}${page + 1}` });
  }

  return row.length ? { inline_keyboard: [row] } : undefined;
}

async function sendOrdersPage(bot, chatId, userId, page, messageId = null) {
  const { orders, total } = await repo.getOrdersForCustomer(userId, {
    limit: ORDERS_PAGE_SIZE,
    offset: page * ORDERS_PAGE_SIZE,
  });

  if (total === 0) {
    await bot.sendMessage(chatId, "You haven't placed any orders yet.\n\nTap /start to place one.");
    return;
  }

  const text = buildOrdersPageText(orders, page, total);
  const keyboard = buildOrdersKeyboard(page, total);

  if (messageId) {
    await editMessageTextSafely(bot, text, {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: keyboard,
    });
    return;
  }

  await bot.sendMessage(chatId, text, keyboard ? { reply_markup: keyboard } : {});
}


// --- Callbacks ---------------------------------------------------------------

async function handleUserCallback(bot, query) {
  const chatId = query.message.chat.id;
  const userId = query.from.id;
  const data = query.data;

  if (data.startsWith(USER_CALLBACKS.ORDERS_PAGE_PREFIX)) {
    const page = Number(data.slice(USER_CALLBACKS.ORDERS_PAGE_PREFIX.length)) || 0;
    await sendOrdersPage(bot, chatId, userId, page, query.message.message_id);
    await answerCallbackSafely(bot, query.id);
    return true;
  }

  if (data.startsWith(USER_CALLBACKS.SELECT_HALL_PREFIX)) {
    return handleSelectHall(bot, query, chatId, userId, data);
  }

  if (data.startsWith(USER_CALLBACKS.ADD_FOOD_PREFIX)) {
    return handleAddFood(bot, query, chatId, userId, data);
  }

  if (data === USER_CALLBACKS.CONFIRM_ORDER) {
    return handleConfirmOrder(bot, query, chatId, userId);
  }

  if (data === USER_CALLBACKS.CLEAR_CART) {
    return handleClearCart(bot, query, chatId, userId);
  }

  return false;
}

async function handleSelectHall(bot, query, chatId, userId, data) {
  const hallId = Number(data.slice(USER_CALLBACKS.SELECT_HALL_PREFIX.length));
  const hall = (await getHalls()).find(entry => entry.id === hallId);

  if (!hall) {
    await answerCallbackSafely(bot, query.id, 'Hall not found', { show_alert: true });
    return true;
  }

  if (!await isOrderingOpen()) {
    await answerCallbackSafely(bot, query.id, 'Ordering is not open yet.', { show_alert: true });
    return true;
  }

  const blocked = await orderStore.loadBlockedHalls();

  if (blocked.isBlocked(hall.name)) {
    await answerCallbackSafely(bot, query.id, `Ordering for ${hall.name} is closed`, { show_alert: true });
    return true;
  }

  await cartStore.setHall(userId, hall);
  await showOrderScreen(bot, chatId, userId, query.message.message_id);
  await answerCallbackSafely(bot, query.id, `Hall: ${hall.name}`);
  return true;
}

async function handleAddFood(bot, query, chatId, userId, data) {
  const foodId = Number(data.slice(USER_CALLBACKS.ADD_FOOD_PREFIX.length));
  const cart = await cartStore.getCart(userId);

  if (!cart.hallName) {
    await answerCallbackSafely(bot, query.id, 'Please select a hall first using /start', { show_alert: true });
    return true;
  }

  if (!await isOrderingOpen()) {
    await answerCallbackSafely(bot, query.id, 'Ordering is not open yet.', { show_alert: true });
    await showOrderScreen(bot, chatId, userId, query.message.message_id);
    return true;
  }

  const blocked = await orderStore.loadBlockedHalls();

  if (blocked.isBlocked(cart.hallName)) {
    await answerCallbackSafely(bot, query.id, `Ordering for ${cart.hallName} is closed`, { show_alert: true });
    await showOrderScreen(bot, chatId, userId, query.message.message_id);
    return true;
  }

  const item = (await getFoodItems()).find(food => food.id === foodId);

  if (!item) {
    await answerCallbackSafely(bot, query.id, 'Food item not found', { show_alert: true });
    return true;
  }

  // Advisory only. The authoritative stock check happens inside the lock at
  // confirm time, because stock can change between tapping and confirming.
  if (cartStore.getQuantity(cart, foodId) >= (item.stock || 0)) {
    await answerCallbackSafely(bot, query.id);
    await bot.sendMessage(chatId, `❌ Sorry, there is no more stock for ${item.name}.`);
    return true;
  }

  // The name is recorded alongside the quantity so checkout can detect the
  // spreadsheet row having shifted under this cart.
  await cartStore.addItem(userId, foodId, item.name);
  await showOrderScreen(bot, chatId, userId, query.message.message_id);
  await answerCallbackSafely(bot, query.id, `Added: ${item.name}`);
  return true;
}

async function handleClearCart(bot, query, chatId, userId) {
  const cart = await cartStore.getCart(userId);

  if (!cart.hallName) {
    await answerCallbackSafely(bot, query.id, 'Please select a hall first using /start', { show_alert: true });
    return true;
  }

  if (cartStore.isEmpty(cart)) {
    await answerCallbackSafely(bot, query.id, 'Cart is already empty.');
    return true;
  }

  await cartStore.clearItems(userId);
  await showOrderScreen(bot, chatId, userId, query.message.message_id);
  await answerCallbackSafely(bot, query.id, 'Cart cleared');
  return true;
}

/**
 * Confirm an order: re-validate stock, deduct it, and create the order.
 *
 * Runs inside a Postgres lease lock rather than the original in-process promise
 * chain. The promise chain serialised one Node process, which stopped being
 * sufficient the moment two serverless instances could handle two customers
 * confirming the last item at the same time.
 */
async function handleConfirmOrder(bot, query, chatId, userId) {
  // Checked before the lock/stock touch anything: a customer with no phone
  // number on file (their first order, or any order predating this feature)
  // gets asked for one and must tap Confirm Order again once they reply.
  const customer = await repo.getCustomerByTelegramId(userId);

  if (!customer || !customer.phone_number) {
    await answerCallbackSafely(bot, query.id);
    await requestPhoneNumber(bot, chatId, userId);
    return true;
  }

  let reservation = null;

  try {
    reservation = await stateStore.withLock(stateStore.LOCKS.confirmOrder(), async () => {
      const cart = await cartStore.getCart(userId);

      if (!cart.hallName) {
        await answerOrSend(bot, query, 'Please select a hall first using /start', { show_alert: true });
        return null;
      }

      if (!await isOrderingOpen()) {
        await answerOrSend(bot, query, 'Ordering is not open yet.', { show_alert: true });
        await showOrderScreen(bot, chatId, userId, query.message.message_id);
        return null;
      }

      const blocked = await orderStore.loadBlockedHalls();

      if (blocked.isBlocked(cart.hallName)) {
        await answerOrSend(bot, query, `Ordering for ${cart.hallName} is closed`, { show_alert: true });
        await showOrderScreen(bot, chatId, userId, query.message.message_id);
        return null;
      }

      const entries = cartStore.cartEntries(cart);

      if (!entries.length) {
        await answerOrSend(bot, query, 'Your cart is empty.', { show_alert: true });
        return null;
      }

      const liveItems = await getFoodItems();

      // An item's id is its spreadsheet row number, so rows being deleted or
      // sorted while this cart was open would silently repoint it at different
      // food. Refuse rather than charge for something they never chose.
      const mismatch = cartStore.findCartMismatch(entries, liveItems);

      if (mismatch) {
        log('warn', 'cart_item_mismatch', {
          food_row_id: mismatch.foodId,
          expected: mismatch.expected,
          actual: mismatch.actual,
        });

        await cartStore.clearItems(userId);
        await answerCallbackSafely(bot, query.id);
        await bot.sendMessage(
          chatId,
          '⚠️ The menu changed while you were ordering, so your cart is no longer valid.\n\n'
          + 'Nothing has been charged. Please start again with /start.'
        );
        return null;
      }

      const stockUpdates = [];
      const stockChanges = [];
      const orderItems = [];
      let totalCents = 0;

      for (const { foodId, quantity } of entries) {
        const item = liveItems.find(food => food.id === foodId);

        if (!item || (item.stock || 0) < quantity) {
          await cartStore.clearItems(userId);
          await answerCallbackSafely(bot, query.id);
          await bot.sendMessage(
            chatId,
            '❌ An error has occurred. Your cart has been cleared. Please restart your order by typing /start.'
          );
          return null;
        }

        const unitPriceCents = toCents(item.price) || 0;
        totalCents += unitPriceCents * quantity;

        const oldStock = item.stock || 0;
        const newStock = oldStock - quantity;

        stockUpdates.push({ rowId: item.id, newStock });
        stockChanges.push({ name: item.name, oldStock, newStock });
        orderItems.push({
          foodSheetRowId: item.id,
          name: item.name,
          unitPriceCents,
          quantity,
        });
      }

      const deducted = await updateFoodItemStocksBatch(stockUpdates);

      if (!deducted.success) {
        await cartStore.clearItems(userId);
        await answerCallbackSafely(bot, query.id);
        await bot.sendMessage(
          chatId,
          '❌ An error has occurred. Your cart has been cleared. Please restart your order by typing /start.'
        );
        return null;
      }

      let order;
      try {
        order = await orderStore.createPendingOrder({
          userId,
          userName: query.from.first_name || 'Unknown',
          username: query.from.username || null,
          chatId,
          hallName: cart.hallName,
          hallSheetRowId: cart.hallSheetRowId,
          items: orderItems,
          totalCents,
          // DO NOT DELETE the legacy admin-approval path. New orders bypass it.
          requiresAdminApproval: false,
        });
      } catch (error) {
        // Stock was already deducted, so put it back rather than losing it.
        log('error', 'order_create_failed_restocking', { error: error.message });

        await updateFoodItemStocksBatch(
          stockUpdates.map((update, index) => ({
            rowId: update.rowId,
            newStock: update.newStock + orderItems[index].quantity,
          }))
        );

        await answerCallbackSafely(bot, query.id);
        await bot.sendMessage(chatId, '❌ Could not save your order. Please try again with /start.');
        return null;
      }

      await cartStore.clearCart(userId);
      await answerCallbackSafely(bot, query.id, 'Processing your order...');

      // stockChanges is only announced once the order actually exists - if
      // creation had failed above, the deduction was reverted, so nothing
      // really sold out.
      return { order, stockChanges };
    });
  } catch (error) {
    if (error.code === 'LOCK_TIMEOUT') {
      await answerOrSend(bot, query, 'We are busy right now, please tap Confirm again.', { show_alert: true });
      return true;
    }
    throw error;
  }

  if (!reservation) {
    return true;
  }

  const { order, stockChanges } = reservation;

  // Everything below is outside the lock: it talks to Telegram, not to stock.
  try {
    await bot.deleteMessage(chatId, query.message.message_id);
  } catch (error) {
    log('warn', 'delete_cart_message_failed', { error: error.message });
  }

  // DO NOT DELETE: legacy order approval is intentionally disabled.
  // To restore it, remove requiresAdminApproval: false above, restore this call,
  // and remove the direct payment-instruction call below.
  // await notifyAdminsOfNewOrder(bot, order);
  const { sendPaymentInstructions, refreshPreorderPostAfterStockChange, refreshHallServeOrdersMessage } = require('./admin');
  await sendPaymentInstructions(bot, order);
  await require('./deliveryMode').refreshDeliveryModeMenus(bot);
  await refreshPreorderPostAfterStockChange(bot, stockChanges);
  await refreshHallServeOrdersMessage(bot, order.hallName);
  return true;
}

async function notifyAdminsOfNewOrder(bot, order) {
  // DO NOT DELETE: retained for restoring the optional admin-approval flow.
  const text = `🛎️ New Order ${order.code}\n👤 User: ${orderActions.describeCustomer(order)}\n`
    + `🏢 Hall: ${order.hallName}\n\n🧾 Order Summary:\n${orderActions.buildOrderSummary(order)}`;

  const keyboard = {
    inline_keyboard: [[
      { text: '✅ Confirm', callback_data: `${CALLBACKS.ORDER_CONFIRM_PREFIX}${order.id}` },
      { text: '❌ Reject', callback_data: `${CALLBACKS.ORDER_REJECT_PREFIX}${order.id}` },
    ]],
  };

  for (const adminId of getAdminIds()) {
    try {
      await bot.sendMessage(adminId, text, { reply_markup: keyboard });
    } catch (error) {
      log('warn', 'admin_new_order_notify_failed', {
        order_code: order.code,
        admin_id: adminId,
        error: error.message,
      });
    }
  }
}


// --- Payment receipts --------------------------------------------------------

/**
 * Handle an incoming payment screenshot, sent either as a photo or, to avoid
 * Telegram's compression, as an image document.
 */
async function handleUserPhoto(bot, msg) {
  const userId = msg.from.id;
  const chatId = msg.chat.id;

  const order = await orderStore.getAwaitingPaymentOrder(userId);

  if (!order) {
    // Matches the previous behaviour for an unexpected photo: ignore it.
    return false;
  }

  if (order.status === STATUS.VERIFYING_PAYMENT) {
    await bot.sendMessage(chatId, paymentVerifier.MESSAGES.STILL_CHECKING);
    return true;
  }

  if (order.status === STATUS.PAYMENT_FLAGGED) {
    await bot.sendMessage(chatId, paymentVerifier.MESSAGES.ALREADY_UNDER_REVIEW);
    return true;
  }

  // The deadline is judged here, on receipt, rather than when verification
  // finishes, so a slow check never costs someone their order. Expiring it
  // immediately (rather than leaving it for the sweeper's next tick) avoids a
  // second, disconnected-looking "has expired" message landing minutes later.
  if (await hasPaymentWindowElapsed(order)) {
    const expired = await orderActions.expireOrder(bot, order);

    if (expired) {
      // The order was awaiting_payment (active), so it may be sitting in its
      // hall's cached "we are here" list - drop it now, same as the sweeper.
      const { refreshHallServeOrdersMessage } = require('./admin');
      await refreshHallServeOrdersMessage(bot, expired.hallName).catch(() => {});
    } else {
      await bot.sendMessage(
        chatId,
        `⌛ The payment window for Order ${order.code} has closed. Please restart your order by typing /start.`
      );
    }

    return true;
  }

  const file = extractReceiptFile(msg);

  if (!file) {
    return false;
  }

  // Sent BEFORE any download or model call, so the customer sees an immediate
  // acknowledgement rather than silence.
  const processingMessage = await bot.sendMessage(chatId, paymentVerifier.MESSAGES.PROCESSING);

  const submitted = await paymentVerifier.submitReceipt(bot, {
    order,
    telegramMessageId: msg.message_id,
    fileId: file.fileId,
    fileUniqueId: file.fileUniqueId,
    mimeType: file.mimeType,
    processingMessageId: processingMessage.message_id,
  });

  if (submitted.rejected) {
    await bot.sendMessage(chatId, paymentVerifier.MESSAGES.STILL_CHECKING);
    return true;
  }

  return { submissionId: submitted.submission.id };
}

function extractReceiptFile(msg) {
  if (msg.photo && msg.photo.length) {
    // Largest rendition: the compressed thumbnails routinely lose the
    // reference number entirely.
    const photo = msg.photo[msg.photo.length - 1];
    return { fileId: photo.file_id, fileUniqueId: photo.file_unique_id, mimeType: 'image/jpeg' };
  }

  if (isImageDocument(msg.document)) {
    return {
      fileId: msg.document.file_id,
      fileUniqueId: msg.document.file_unique_id,
      mimeType: msg.document.mime_type,
    };
  }

  return null;
}

async function hasPaymentWindowElapsed(order) {
  if (!config.payment.expiryEnabled || !order.paymentDueAt) {
    return false;
  }

  return new Date(order.paymentDueAt).getTime() < Date.now();
}

module.exports = {
  USER_CALLBACKS,
  STATUS_LABELS,
  ORDERS_PAGE_SIZE,
  handleUserCommand,
  handleUserCallback,
  handleUserPhoto,
  sendFallbackHint,
  sendOrdersPage,
  buildOrdersPageText,
  buildOrdersKeyboard,
  buildOrderText,
  notifyAdminsOfNewOrder,
  normalizePhoneNumber,
  requestPhoneNumber,
  handlePhoneNumberReply,
  handleConfirmOrder,
};
