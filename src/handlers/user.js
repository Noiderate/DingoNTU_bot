const googleSheets = require('../services/googleSheets');
const { isAdmin, getAdminIds } = require('../services/googleSheets');
const menuStore = require('../services/menuStore');
const { isTemporarilyUnavailable } = require('../utils/unavailable');
const { CALLBACKS } = require('../config/constants');
const orderWindow = require('../services/orderWindow');
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
const { createCallbackItemToken } = require('../utils/keyboards');
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

const ORDERING_NOT_OPEN_TEXT = '⏳ Ordering is closed right now, but the next order window will open soon. Keep an eye on the channel!';
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
  return orderWindow.isOrderingOpen();
}


// --- Phone number collection ---------------------------------------------------

/**
 * Staff at a hall need a way to identify a customer that survives them
 * closing the app - a Telegram handle doesn't. Collected once, on a
 * customer's first /start, with a second check at Confirm Order as a backstop
 * for carts that were already open before they had a number on file.
 *
 * Kept permissive rather than Singapore-only: NTU has a lot of international
 * students, and rejecting a real foreign number would just block an order for
 * no benefit. Strips everything but digits and accepts a plausible length.
 *
 * A Singapore number's 65 country code is dropped, so a typed "91234567" and a
 * shared contact's "6591234567" (Telegram always sends the full international
 * form) are stored the same way.
 */
function normalizePhoneNumber(text) {
  let digits = String(text || '').replace(/\D/g, '');

  if (digits.length === 10 && digits.startsWith('65')) {
    digits = digits.slice(2);
  }

  return digits.length >= 7 && digits.length <= 15 ? digits : null;
}

// A reply keyboard button that sends the customer's own number in one tap.
const SHARE_PHONE_KEYBOARD = {
  keyboard: [[{ text: '📱 Share phone number', request_contact: true }]],
  resize_keyboard: true,
  one_time_keyboard: true,
};

// Where the phone-number prompt was raised, which decides what happens once
// the number is saved. Stored as the awaitingPhoneNumber state's value.
const PHONE_PROMPT = {
  // From /start: carry straight on to the hall menu.
  START: 'start',
  // From Confirm Order: the customer taps Confirm again. A legacy `true`
  // state value is treated the same way.
  CONFIRM: 'confirm',
};

async function requestPhoneNumber(bot, chatId, userId, prompt = PHONE_PROMPT.CONFIRM) {
  await stateStore.set(stateStore.KEYS.awaitingPhoneNumber(userId), prompt, { ttlMs: 30 * 60 * 1000 });

  const text = prompt === PHONE_PROMPT.START
    ? '👋 Welcome! Before you order, we need a contact number so staff can reach you at the hall.\n\n'
      + 'Tap 📱 Share phone number below, or type your number (e.g. 91234567).'
    : '📱 Before we can confirm your order, we need a contact number so staff can reach you at the hall.\n\n'
      + 'Tap 📱 Share phone number below, or type your number (e.g. 91234567). '
      + 'Then tap ✅ Confirm Order again.';

  await bot.sendMessage(chatId, text, { reply_markup: SHARE_PHONE_KEYBOARD });
}

/** Handles both a typed number and a contact shared via the button. */
async function handlePhoneNumberReply(bot, msg, prompt = PHONE_PROMPT.CONFIRM) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  // The button only ever sends the customer's own contact, but any saved
  // contact can also be sent from the attachment menu - refuse those.
  if (msg.contact && msg.contact.user_id !== userId) {
    await bot.sendMessage(
      chatId,
      '❌ Please share your own number using the 📱 Share phone number button, or type it in.'
    );
    return true;
  }

  const phoneNumber = normalizePhoneNumber(msg.contact ? msg.contact.phone_number : msg.text);

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

  if (prompt === PHONE_PROMPT.START) {
    await bot.sendMessage(chatId, '✅ Thanks, your number is saved!', {
      reply_markup: { remove_keyboard: true },
    });
    await sendHallMenu(bot, chatId, userId);
    return true;
  }

  await bot.sendMessage(chatId, '✅ Thanks! Now tap ✅ Confirm Order again to complete your order.', {
    reply_markup: { remove_keyboard: true },
  });
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

  const foodItems = await menuStore.getFoodItemsOrThrow();

  await editMessageTextSafely(bot, buildOrderText(cart.hallName, foodItems, cart), {
    chat_id: chatId,
    message_id: messageId,
    reply_markup: buildFoodKeyboard(foodItems),
  });
}


// --- Commands ----------------------------------------------------------------

const SHEETS_UNAVAILABLE_TEXT = "⚠️ We're having a temporary problem loading the menu. "
  + 'Anything in your cart is still saved - please try again in a moment.';

/**
 * A failed read of the halls (Google Sheets) or the menu (the database) used to
 * look exactly like an empty one: no halls, no food, "the menu changed" and a
 * cleared cart. The throwing readers flag it instead, and it is turned into a
 * retry message here, with the cart left untouched.
 */
async function handleUserCommand(bot, msg) {
  try {
    return await routeUserCommand(bot, msg);
  } catch (error) {
    if (!isTemporarilyUnavailable(error)) {
      throw error;
    }
    log('warn', 'sheets_unavailable', { error: error.message });
    await bot.sendMessage(msg.chat.id, SHEETS_UNAVAILABLE_TEXT);
    return true;
  }
}

async function handleUserCallback(bot, query) {
  try {
    return await routeUserCallback(bot, query);
  } catch (error) {
    if (!isTemporarilyUnavailable(error)) {
      throw error;
    }
    log('warn', 'sheets_unavailable', { error: error.message });
    await answerOrSend(bot, query, SHEETS_UNAVAILABLE_TEXT, { show_alert: true });
    return true;
  }
}

// Telegram won't let a bot delete its messages after 48 hours, so there is no
// point remembering a menu for longer than that.
const MENU_MESSAGE_TTL_MS = 48 * 60 * 60 * 1000;

/**
 * Only one /start menu per customer: a repeat /start deletes the previous one
 * so they can start over without stale menus piling up. Best-effort - the menu
 * is usually already gone (deleted on Confirm Order), which is fine.
 */
async function deletePreviousMenu(bot, userId) {
  const key = stateStore.KEYS.userMenuMessage(userId);
  const previous = await stateStore.get(key);

  if (!previous) {
    return;
  }

  await stateStore.remove(key);

  try {
    await bot.deleteMessage(previous.chatId, previous.messageId);
  } catch (error) {
    log('info', 'delete_previous_menu_skipped', { error: error.message });
  }
}

/** The "select your hall" menu, remembered so a repeat /start can delete it. */
async function sendHallMenu(bot, chatId, userId) {
  // Re-checked because a phone-number reply can arrive well after /start.
  if (!await isOrderingOpen()) {
    await bot.sendMessage(chatId, ORDERING_NOT_OPEN_TEXT);
    return;
  }

  const blocked = await orderStore.loadBlockedHalls();
  const halls = (await googleSheets.getHallsOrThrow()).filter(hall => !blocked.isBlocked(hall.name));

  if (halls.length === 0) {
    await bot.sendMessage(chatId, 'No halls available for ordering right now. Please contact an admin.');
    return;
  }

  const menuMessage = await bot.sendMessage(
    chatId,
    '🏢 Welcome! Please select your hall:\n\n'
    + 'Note: If your usual pickup location is not listed, ordering for that hall has already closed.',
    {
      reply_markup: {
        inline_keyboard: halls.map(hall => [{
          text: hall.name,
          callback_data: `${USER_CALLBACKS.SELECT_HALL_PREFIX}${hall.id}:${createCallbackItemToken(hall.name)}`,
        }]),
      },
    }
  );

  if (menuMessage && menuMessage.message_id) {
    await stateStore.set(
      stateStore.KEYS.userMenuMessage(userId),
      { chatId, messageId: menuMessage.message_id },
      { ttlMs: MENU_MESSAGE_TTL_MS }
    );
  }
}

async function routeUserCommand(bot, msg) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const text = msg.text;

  // A contact shared via the 📱 Share phone number button has no text.
  if (msg.contact) {
    const prompt = await stateStore.get(stateStore.KEYS.awaitingPhoneNumber(userId));
    return prompt ? handlePhoneNumberReply(bot, msg, prompt) : false;
  }

  if (!text) {
    return false;
  }

  // A slash command always wins over a pending phone-number prompt, same as
  // the admin input-state pattern - typing /start mid-prompt should not get
  // swallowed as a (garbage) phone number attempt.
  const isCommand = text.startsWith('/');

  if (!isCommand) {
    const prompt = await stateStore.get(stateStore.KEYS.awaitingPhoneNumber(userId));

    if (prompt) {
      return handlePhoneNumberReply(bot, msg, prompt);
    }
  }

  // Handles the /start order deep link from the channel post too.
  if (text === '/start' || text.startsWith('/start ')) {
    await cartStore.clearCart(userId);
    await deletePreviousMenu(bot, userId);

    if (!await isOrderingOpen()) {
      await bot.sendMessage(chatId, ORDERING_NOT_OPEN_TEXT);
      return true;
    }

    // First-timers give a contact number before seeing the halls; saving it
    // carries them straight on to the hall menu.
    const customer = await repo.getCustomerByTelegramId(userId);

    if (!customer || !customer.phone_number) {
      await requestPhoneNumber(bot, chatId, userId, PHONE_PROMPT.START);
      return true;
    }

    await sendHallMenu(bot, chatId, userId);
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

async function routeUserCallback(bot, query) {
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
  // A hall's id is its sheet row, so deleting a hall shifts every hall below
  // it - the name token catches a button now pointing at a different hall.
  // Buttons sent before the token existed carry none and are accepted as-is.
  const [idValue, token] = data.slice(USER_CALLBACKS.SELECT_HALL_PREFIX.length).split(':');
  const hallId = Number(idValue);
  const hall = (await googleSheets.getHallsOrThrow()).find(entry => entry.id === hallId);

  if (!hall || (token && createCallbackItemToken(hall.name) !== token)) {
    await answerCallbackSafely(bot, query.id, 'The hall list has changed. Please tap /start again.', { show_alert: true });
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
    // No popup: taps queued behind a confirm land here once the cart is gone.
    await answerCallbackSafely(bot, query.id, 'Please select a hall first using /start');
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

  const item = (await menuStore.getFoodItemsOrThrow()).find(food => food.id === foodId);

  if (!item) {
    await answerCallbackSafely(bot, query.id, 'Food item not found', { show_alert: true });
    return true;
  }

  // Advisory only. The authoritative stock check happens inside the lock at
  // confirm time, because stock can change between tapping and confirming.
  if (cartStore.getQuantity(cart, foodId) >= (item.stock || 0)) {
    await answerCallbackSafely(bot, query.id);
    await bot.sendMessage(chatId, `❌ ${item.name} is sold out.`);
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
 * The customer's cart can't be fulfilled: an item ran out (or was removed) since
 * they added it. Their cart is cleared and they are told which item, when known.
 */
async function rejectCartForStock(bot, query, chatId, userId, itemName, available) {
  await cartStore.clearItems(userId);
  await answerCallbackSafely(bot, query.id);

  const reason = itemName
    ? `❌ Sorry, ${itemName} ${Number(available) > 0 ? `only has ${available} left` : 'has just run out'}. `
    : '❌ An error has occurred. ';

  await bot.sendMessage(
    chatId,
    `${reason}Your cart has been cleared. Please restart your order by typing /start.`
  );
}

/**
 * Confirm an order: re-validate stock, deduct it, and create the order.
 *
 * Overselling is prevented by the database, not a lock: menuStore.deductStock
 * subtracts every item in one atomic statement that only succeeds if all of them
 * have enough left, so two customers confirming the last item at the same time
 * cannot both get it - and nobody queues behind anybody else.
 *
 * The lock taken here is per customer. It only serialises one customer's own
 * taps: a double tap on Confirm would otherwise read the same cart twice and
 * place two orders, where serialised the second sees the cleared cart.
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
    reservation = await stateStore.withLock(stateStore.LOCKS.confirmOrder(userId), async () => {
      const cart = await cartStore.getCart(userId);

      if (!cart.hallName) {
        // Usually a repeated tap on Confirm: the first one already placed the
        // order and cleared the cart. Answer quietly (no popup, and no chat
        // message if the query has expired) instead of repeating an error for
        // every extra tap.
        await answerCallbackSafely(bot, query.id, 'Your order was already submitted. Use /start to order again.');
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

      const liveItems = await menuStore.getFoodItemsOrThrow();

      // Item ids no longer shift, but an item can still be deleted (or deleted
      // and re-added under a new id) while this cart was open. Refuse rather
      // than charge for something that is no longer what they chose.
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

      const orderItems = [];
      let totalCents = 0;

      for (const { foodId, quantity } of entries) {
        const item = liveItems.find(food => food.id === foodId);

        // A quick check against what was just read, to skip the deduction when
        // it is already known to fail. The deduction below is the authority.
        if (!item || (item.stock || 0) < quantity) {
          await rejectCartForStock(bot, query, chatId, userId, item ? item.name : null, item ? item.stock : 0);
          return null;
        }

        const unitPriceCents = toCents(item.price) || 0;
        totalCents += unitPriceCents * quantity;

        orderItems.push({
          foodSheetRowId: item.id,
          name: item.name,
          unitPriceCents,
          quantity,
        });
      }

      // Atomic: every item is deducted, or none. A database failure throws
      // (MENU_UNAVAILABLE) with nothing deducted, which handleUserCallback turns
      // into "try again, your cart is still saved".
      const deducted = await menuStore.deductStock(entries);

      if (!deducted.success) {
        // Someone else took the stock between the read above and now.
        await rejectCartForStock(bot, query, chatId, userId, deducted.name, deducted.available);
        return null;
      }

      // The stock levels as they really were at deduction time, so a "sold out"
      // announcement is only raised by the checkout that actually emptied the item.
      const stockChanges = deducted.changes;

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

        const restored = await menuStore.restoreStock(
          entries.map(({ foodId, quantity }) => ({ id: foodId, quantity }))
        );

        if (!restored.success) {
          log('error', 'restock_failed_after_order_create_failure', {
            error: restored.message,
            items: orderItems.map(item => `${item.name} x${item.quantity}`),
          });
        }

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
  const {
    sendPaymentInstructions, refreshPreorderPostAfterStockChange, refreshHallServeOrdersMessage, refreshDeliveryModeMenus,
  } = require('./admin');
  await sendPaymentInstructions(bot, order);
  await refreshDeliveryModeMenus(bot);
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
    return replyToReceiptWithoutPayableOrder(bot, msg);
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
        `⌛ Order ${order.code}'s payment window closed. /start to reorder.`
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

/**
 * A screenshot arrived but nothing is awaiting payment. Usually the order
 * expired moments earlier: the payment window is short and the sweeper runs
 * every minute, so a slightly late screenshot almost always lands here - and
 * used to be ignored, leaving someone who had actually paid with no reply.
 *
 * Returns true when it replied, false to leave the photo unhandled.
 */
async function replyToReceiptWithoutPayableOrder(bot, msg) {
  if (!extractReceiptFile(msg)) {
    return false;
  }

  const { orders } = await repo.getOrdersForCustomer(msg.from.id, { limit: 1 });
  const latest = orders[0] ? orderStore.toOrder(orders[0]) : null;

  if (!latest) {
    // Admins send photos for their own reasons; don't lecture them.
    if (isAdmin(msg.from.id)) {
      return false;
    }

    await bot.sendMessage(msg.chat.id, "You don't have an order waiting for payment. Tap /start to place one.");
    return true;
  }

  if (latest.status === STATUS.EXPIRED) {
    await bot.sendMessage(msg.chat.id, orderActions.expiredOrderMessage(latest.code));
    return true;
  }

  if (latest.status === STATUS.PAID || (latest.status === STATUS.SERVED && latest.paidAt)) {
    await bot.sendMessage(msg.chat.id, `✅ Payment for Order ${latest.code} is already confirmed. Nothing more is needed.`);
    return true;
  }

  if (latest.status === STATUS.SERVED) {
    // Served before payment cleared, and the customer was asked to complete
    // it. There is no automatic path from SERVED, so hand the screenshot
    // straight to the admins with the same Mark Paid button they already use.
    await forwardServedUnpaidReceipt(bot, latest, extractReceiptFile(msg).fileId);
    await bot.sendMessage(msg.chat.id, `Thanks! An admin will confirm the payment for Order ${latest.code} shortly.`);
    return true;
  }

  await bot.sendMessage(
    msg.chat.id,
    `Order ${latest.code} is not waiting for a payment screenshot (${STATUS_LABELS[latest.status] || latest.status}).\n\n`
    + 'Tap /orders to see your orders, or /start to place a new one.'
  );
  return true;
}

async function forwardServedUnpaidReceipt(bot, order, fileId) {
  const caption = `🧾 Payment screenshot for Order ${order.code} (served before payment)\n`
    + `👤 ${orderActions.describeCustomer(order)}\n`
    + `💰 Amount due: ${formatCents(order.totalCents)}\n\n`
    + 'Check it and mark the order paid if it is correct.';

  const keyboard = {
    inline_keyboard: [[{ text: '✅ Mark Paid', callback_data: `${CALLBACKS.PAYMENT_ACCEPT_PREFIX}${order.id}` }]],
  };

  for (const adminId of googleSheets.getAdminIds()) {
    try {
      await bot.sendPhoto(adminId, fileId, { caption, reply_markup: keyboard });
    } catch (error) {
      log('warn', 'served_unpaid_receipt_forward_failed', { order_code: order.code, admin_id: adminId, error: error.message });
    }
  }
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
