const googleSheets = require('../services/googleSheets');
const {
  isAdmin, getAdminIds, reloadAdminIds, addAdmin, deleteAdmin,
  getFoodItems, addFoodItem, deleteFoodItem, updateFoodItemStock,
  getHalls, addHall, deleteHall,
  getPreorderAdminTag, getAdminUsernameById, writeToSheet,
} = googleSheets;
const { CALLBACKS, STATES, isCallbackType, extractCallbackValue } = require('../config/constants');
const keyboards = require('../utils/keyboards');
const menuTexts = require('../utils/menuTexts');
const { buildComingChannelMessage } = require('../utils/channelMessages');
const { editMessageTextSafely, editMessageCaptionSafely } = require('../utils/telegramEdits');
const orderStore = require('../services/orderStore');
const orderActions = require('../services/orderActions');
const repo = require('../services/orderRepository');
const stateStore = require('../services/stateStore');
const cartStore = require('../services/cartStore');
const paynowQr = require('../services/paynowQr');
const { getMenuMessageId, setMenuMessageId, clearMenuMessageId } = require('../services/chatTracker');
const { config } = require('../config');
const { formatCents } = require('../utils/money');
const { isImageDocument } = require('../utils/telegramFiles');
const { log } = require('../utils/logger');
const {
  advanceNextHallToPost,
  isExpectedNextHallToPost,
  getNextHallToPostState,
  recordDingoPost,
  getDingoMsgIdsToDelete,
  consumeTrackedDingoMessageIds,
  recordHallServeMessage,
  getHallServeMessage,
  clearHallServeMessage,
  recordPreorderPost,
  getPreorderPost,
  showDeliveryModeMenu,
  setDeliveryModeViewer,
  clearDeliveryModeViewer,
  refreshDeliveryModeMenus,
} = require('./deliveryMode');

const STATUS = repo.STATUS;


// --- Admin input state (was the in-memory adminStates object) ----------------

async function getAdminState(userId) {
  return stateStore.get(stateStore.KEYS.adminInputState(userId), null);
}

async function setAdminState(userId, value) {
  // Expires so an admin who abandons a prompt is not stuck in it forever.
  return stateStore.set(stateStore.KEYS.adminInputState(userId), value, { ttlMs: 60 * 60 * 1000 });
}

async function clearAdminState(userId) {
  return stateStore.remove(stateStore.KEYS.adminInputState(userId));
}


// --- Helpers (unchanged from the original) -----------------------------------

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

// --- Hall serve list: grouped by customer, phone number first --------------
//
// Tapping "we are here" used to list one button per order, labelled with the
// Telegram handle. Staff at the hall need a phone number, not a handle, and
// a customer with two orders should be one entry, not two - so the list now
// groups by customer, and drills into a per-order Served/Dropped off
// submenu on tap.

const SERVE_TEXT_MAX_LENGTH = 60;

function truncate(text, max = SERVE_TEXT_MAX_LENGTH) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function formatOrderItems(order) {
  return (order.items || []).map(item => `${item.name} x${item.quantity}`).join(', ');
}

/**
 * One entry per customer, each carrying every order they still have active
 * at this hall. Order of entries is not meaningful here - see
 * sortCustomerGroups for the phone-number ordering shown to staff.
 */
function groupOrdersByCustomer(orders) {
  const groups = new Map();

  for (const order of orders) {
    const key = order.userId;
    if (!groups.has(key)) {
      groups.set(key, {
        telegramUserId: key,
        phone: order.phoneNumber || null,
        handle: order.username ? `@${order.username}` : (order.userName || `User ${key}`),
        orders: [],
      });
    }
    groups.get(key).orders.push(order);
  }

  return [...groups.values()];
}

/**
 * Phone number first (the whole point of this list), customers with no
 * number on file (pre-dating this feature) pushed to the bottom under their
 * handle instead.
 */
function sortCustomerGroups(groups) {
  return [...groups].sort((a, b) => {
    if (a.phone && b.phone) return a.phone.localeCompare(b.phone);
    if (a.phone) return -1;
    if (b.phone) return 1;
    return (a.handle || '').localeCompare(b.handle || '');
  });
}

function formatCustomerListButtonText(group) {
  const label = group.phone || `${group.handle} (no phone on file)`;
  const items = group.orders.map(formatOrderItems).join(' | ');
  return truncate(`${label} — ${items}`);
}

/** {hallName}|{telegramUserId} - split on the LAST separator, since a hall
 * name (admin-entered free text) could in principle contain the character
 * itself, while a Telegram user id never does. */
function encodeCustomerKey(hallName, telegramUserId) {
  return `${hallName}|${telegramUserId}`;
}

function decodeCustomerKey(raw) {
  const sep = raw.lastIndexOf('|');
  return { hallName: raw.slice(0, sep), telegramUserId: Number(raw.slice(sep + 1)) };
}

function buildHallCustomerListKeyboard(hallName, orders) {
  const groups = sortCustomerGroups(groupOrdersByCustomer(orders));

  const buttons = groups.map(group => [{
    text: formatCustomerListButtonText(group),
    callback_data: `${CALLBACKS.DELIVERY_MODE_SERVE_CUSTOMER_PREFIX}${encodeCustomerKey(hallName, group.telegramUserId)}`,
  }]);

  buttons.push([{
    text: '📦 Drop Remaining Items Off',
    callback_data: `${CALLBACKS.DELIVERY_MODE_SERVE_REMAINING_PREFIX}${hallName}`,
  }]);

  return { inline_keyboard: buttons };
}

/**
 * Total quantity per item across every order still uncollected at the hall -
 * what staff need to know to leave the right amount of food behind. Sorted
 * highest-quantity first, matching the Today's Orders sheet totals table.
 */
function collateRemainingItems(orders) {
  const totals = new Map();

  for (const order of orders) {
    for (const item of order.items || []) {
      totals.set(item.name, (totals.get(item.name) || 0) + item.quantity);
    }
  }

  return [...totals.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function buildRemainingItemsText(hallName, orders) {
  const totals = collateRemainingItems(orders);
  const lines = totals.length
    ? totals.map(([name, qty]) => `• ${name} x${qty}`).join('\n')
    : 'Nothing left to drop off.';

  return `📦 Remaining items to drop off at ${hallName}:\n\n${lines}\n\n`
    + `Tap a customer below once you've left their food, to send them a photo of where it is:`;
}

function buildRemainingItemsKeyboard(hallName, orders) {
  const groups = sortCustomerGroups(groupOrdersByCustomer(orders));

  const buttons = groups.map(group => [{
    text: truncate(`${group.phone || 'No phone on file'} | ${group.handle}`),
    callback_data: `${CALLBACKS.DELIVERY_MODE_SERVE_DROPOFF_PREFIX}${encodeCustomerKey(hallName, group.telegramUserId)}`,
  }]);

  buttons.push([{ text: '⬅️ Back', callback_data: `${CALLBACKS.DELIVERY_MODE_SERVE_BACK_PREFIX}${hallName}` }]);

  return { inline_keyboard: buttons };
}

const HALL_SERVE_LIST_HEADER = hallLabel => `✅ ${hallLabel}, we are here\n\nTap a phone number to see their order:`;

function buildCustomerSubmenuText(group) {
  const lines = group.orders.map(order => (
    `🧾 ${order.code} — ${formatOrderItems(order)} — ${formatCents(order.totalCents)}`
  ));

  return `👤 ${group.handle}\n📱 ${group.phone || 'No phone on file'}\n\n${lines.join('\n')}`;
}

function buildCustomerSubmenuKeyboard(hallName, group) {
  const multiple = group.orders.length > 1;

  const orderRows = group.orders.map(order => [
    {
      text: multiple ? `✅ Served (${order.code})` : '✅ Served',
      callback_data: `${CALLBACKS.DELIVERY_MODE_SERVE_MARK_SERVED_PREFIX}${order.id}`,
    },
    {
      text: multiple ? `📦 Dropped off (${order.code})` : '📦 Dropped off',
      callback_data: `${CALLBACKS.DELIVERY_MODE_SERVE_MARK_DROPPED_PREFIX}${order.id}`,
    },
  ]);

  return {
    inline_keyboard: [
      ...orderRows,
      [{ text: '⬅️ Back', callback_data: `${CALLBACKS.DELIVERY_MODE_SERVE_BACK_PREFIX}${hallName}` }],
    ],
  };
}

/**
 * A hall's active orders, read from a short-lived cache written whenever the
 * list is (re)built rather than re-queried on every tap - the whole point is
 * that opening a customer's submenu costs zero extra Supabase round trips in
 * the common case. Falls back to a fresh query if the cache missed (e.g. it
 * expired, or nothing has written it yet).
 */
async function loadHallServeOrders(hallName) {
  const cached = await stateStore.get(stateStore.KEYS.hallServeOrdersCache(hallName), null);
  if (cached) {
    return cached;
  }

  return refreshHallServeOrdersCache(hallName);
}

async function refreshHallServeOrdersCache(hallName) {
  const orders = await orderStore.getActiveOrdersByHall(hallName);
  await stateStore.set(stateStore.KEYS.hallServeOrdersCache(hallName), orders, { ttlMs: 20 * 60 * 1000 });
  return orders;
}

async function getBotStartUrl(bot) {
  const cached = await stateStore.get(stateStore.KEYS.botStartUrl(), null);

  if (cached) {
    return cached;
  }

  try {
    const info = await bot.getMe();

    if (!info || !info.username) {
      return '';
    }

    const url = `https://t.me/${info.username}?start=order`;
    await stateStore.set(stateStore.KEYS.botStartUrl(), url, { ttlMs: 7 * 24 * 60 * 60 * 1000 });
    return url;
  } catch (error) {
    log('warn', 'get_bot_start_url_failed', { error: error.message });
    return '';
  }
}

function buildPreorderStartButton(botStartUrl) {
  if (!botStartUrl) {
    return null;
  }

  return { inline_keyboard: [[{ text: 'Click below to start ordering', url: botStartUrl }]] };
}

function buildAvailableFoodLines(foodItems) {
  const available = foodItems.filter(item => Number(item.stock) > 0);

  if (!available.length) {
    return ['• No food currently available'];
  }

  return available.map(item => `• ${escapeHtml(item.name)}`);
}

async function buildPreorderMessageText(hallLabel, adminUsername) {
  const foodItems = await getFoodItems();
  const contactLine = adminUsername
    ? `Or for any delivery related issues, message @${adminUsername}.`
    : 'Or for any delivery related issues, please contact an admin.';

  return `Preorders available for ${escapeHtml(hallLabel)} onwards\n\n`
    + `Available food:\n${buildAvailableFoodLines(foodItems).join('\n')}\n\n`
    + `Click below to start ordering.\n${contactLine}`;
}

/**
 * Re-render the live preorder channel post.
 *
 * Replaces the original 5-second setInterval, which cannot survive a serverless
 * function ending. Called directly after anything that changes what the post
 * shows, and once a minute by the scheduler to catch edits made straight into
 * the spreadsheet.
 *
 * Skips the Telegram edit when the rendered content is unchanged, so the
 * scheduled call is almost always free.
 */
async function refreshPreorderPost(bot) {
  const post = await getPreorderPost();

  if (!post.channelId || !post.msgId) {
    return { skipped: 'no_post' };
  }

  const halls = await googleSheets.getHalls();
  const blocked = await orderStore.loadBlockedHalls();
  const nextHall = halls.find(hall => !blocked.isBlocked(hall.name));

  if (!nextHall) {
    return { skipped: 'no_unblocked_hall' };
  }

  const adminId = await googleSheets.getPreorderAdminTag();
  const adminUsername = adminId ? await googleSheets.getAdminUsernameById(bot, adminId) : null;
  const text = await buildPreorderMessageText(nextHall.shortName || nextHall.name, adminUsername);
  const startUrl = await getBotStartUrl(bot);

  const contentHash = `${text}::${startUrl}`;

  if (post.contentHash === contentHash) {
    return { skipped: 'unchanged' };
  }

  try {
    const button = buildPreorderStartButton(startUrl);

    await bot.editMessageText(text, {
      chat_id: post.channelId,
      message_id: post.msgId,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...(button ? { reply_markup: button } : {}),
    });

    await stateStore.set(stateStore.KEYS.preorderPost(), { ...post, contentHash });
    return { refreshed: true };
  } catch (error) {
    if (!String(error.message || '').includes('message is not modified')) {
      log('warn', 'preorder_refresh_failed', { error: error.message });
      return { failed: true };
    }

    await stateStore.set(stateStore.KEYS.preorderPost(), { ...post, contentHash });
    return { skipped: 'not_modified' };
  }
}


// --- Sold-out announcements ---------------------------------------------------
//
// Every stock-changing action (a checkout deduction, an admin editing one
// item, an admin's "Edit All Stock" session) reports its before/after values
// here. Most changes just get the normal silent edit-in-place refresh above;
// one that newly crosses an item from having stock to having none instead
// gets a "sold out" post per item and a fresh preorder post - a plain edit
// does not notify channel subscribers, and that is the whole point of
// treating this case differently.

/**
 * Which of a batch of stock changes newly crossed from having stock to
 * having none. Pure, so the "just sold out" rule is unit-testable without a
 * bot or a channel - an item that was already at 0 before this batch is not
 * reported again.
 */
function findNewlySoldOutItems(changes) {
  return (changes || []).filter(change => (change.oldStock || 0) > 0 && (change.newStock || 0) <= 0);
}

/** One "sold out" post per item, best-effort - a failed send must not stop the rest. */
async function announceSoldOut(bot, soldOutItems) {
  const channelId = config.telegram.dingoChannelId;

  if (!channelId) {
    return;
  }

  for (const item of soldOutItems) {
    try {
      await bot.sendMessage(channelId, `🚫 ${item.name} has been sold out!`);
    } catch (error) {
      log('warn', 'sold_out_announce_failed', { item: item.name, error: error.message });
    }
  }
}

/**
 * Delete the live preorder post and send a fresh one, instead of editing it
 * in place like refreshPreorderPost does - used only for the sold-out
 * moment, so it actually notifies channel subscribers. A no-op if there is
 * no live preorder post to replace.
 */
async function repostPreorderAvailability(bot) {
  const post = await getPreorderPost();

  if (!post.channelId || !post.msgId) {
    return;
  }

  const halls = await googleSheets.getHalls();
  const blocked = await orderStore.loadBlockedHalls();
  const nextHall = halls.find(hall => !blocked.isBlocked(hall.name));

  if (!nextHall) {
    return;
  }

  const adminId = await googleSheets.getPreorderAdminTag();
  const adminUsername = adminId ? await googleSheets.getAdminUsernameById(bot, adminId) : null;
  const text = await buildPreorderMessageText(nextHall.shortName || nextHall.name, adminUsername);
  const startUrl = await getBotStartUrl(bot);
  const button = buildPreorderStartButton(startUrl);

  let sent;
  try {
    sent = await bot.sendMessage(post.channelId, text, {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...(button ? { reply_markup: button } : {}),
    });
  } catch (error) {
    log('error', 'preorder_repost_failed', { error: error.message });
    return;
  }

  try {
    await bot.deleteMessage(post.channelId, post.msgId);
  } catch (error) {
    log('warn', 'preorder_repost_delete_failed', { error: error.message });
  }

  await recordPreorderPost(post.channelId, sent.message_id);
}

/**
 * The single place every stock-changing call site refreshes the preorder
 * post from, in place of a plain refreshPreorderPost(bot) call. Routes to
 * the ordinary silent edit unless this batch just sold something out.
 */
async function refreshPreorderPostAfterStockChange(bot, changes) {
  const soldOut = findNewlySoldOutItems(changes);

  if (!soldOut.length) {
    await refreshPreorderPost(bot);
    return;
  }

  await announceSoldOut(bot, soldOut);
  await repostPreorderAvailability(bot);
}


// --- Menu plumbing -----------------------------------------------------------

async function showMainAdminMenu(bot, chatId, userId) {
  await reloadAdminIds();
  await updateMenuMessage(bot, chatId, userId, menuTexts.mainMenuText(), keyboards.mainMenuKeyboard());
}

/**
 * Update the admin's menu in place, or send a new one.
 *
 * Unchanged behaviour; the message id is now read from and written to the
 * durable store rather than a module-level object.
 */
async function updateMenuMessage(bot, chatId, userId, text, keyboard, menuMode = 'default') {
  try {
    const existingId = await getMenuMessageId(userId);
    let updated = false;

    if (existingId) {
      try {
        await editMessageTextSafely(bot, text, {
          chat_id: chatId,
          message_id: existingId,
          reply_markup: keyboard,
        });
        updated = true;
      } catch (error) {
        await clearMenuMessageId(userId);
      }
    }

    if (!updated) {
      const sent = await bot.sendMessage(chatId, text, { reply_markup: keyboard });
      await setMenuMessageId(userId, sent.message_id);
    }

    if (menuMode === 'delivery') {
      await setDeliveryModeViewer(userId, chatId);
    } else {
      await clearDeliveryModeViewer(userId);
    }
  } catch (error) {
    log('error', 'update_menu_failed', { error: error.message });
  }
}


// --- Commands ----------------------------------------------------------------

async function handleAdminCommand(bot, msg) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const text = msg.text;

  if (!isAdmin(userId)) {
    return false;
  }

  // A slash command always wins over a pending prompt. Without this, an admin
  // who opened "Add Hall" and then typed /orders would create a hall called
  // "/orders".
  const isCommand = typeof text === 'string' && text.startsWith('/');
  const state = isCommand ? null : await getAdminState(userId);

  if (state && await handleAdminStateInput(bot, chatId, userId, text, state)) {
    return true;
  }

  if (text === '/adminmenu') {
    await showMainAdminMenu(bot, chatId, userId);
    return true;
  }

  return false;
}

/** Multi-step prompts: add admin, add food, add hall, edit stock. */
async function handleAdminStateInput(bot, chatId, userId, text, state) {
  if (typeof state === 'string') {
    if (state === STATES.ADD_ADMIN) {
      const adminId = Number.parseInt(text, 10);

      if (Number.isNaN(adminId)) {
        await bot.sendMessage(chatId, '❌ Invalid ID. Please enter a valid number.');
        return true;
      }

      const result = await addAdmin(adminId);
      await bot.sendMessage(chatId, result.message);
      await clearAdminState(userId);
      return true;
    }

    if (state === 'add_food_item') {
      const parts = String(text).split(',').map(part => part.trim());

      if (parts.length !== 2) {
        await bot.sendMessage(chatId, '❌ Invalid format. Please use: name, price\n\nExample: Chicken Burger, 5.99');
        return true;
      }

      const price = Number.parseFloat(parts[1]);

      if (Number.isNaN(price)) {
        await bot.sendMessage(chatId, '❌ Invalid price. Please enter a valid number.');
        return true;
      }

      const result = await addFoodItem(parts[0], price);
      await bot.sendMessage(chatId, result.message);
      await clearAdminState(userId);
      await refreshPreorderPost(bot);
      return true;
    }

    if (state === STATES.ADD_HALL) {
      const hallName = String(text || '').trim();

      if (!hallName) {
        await bot.sendMessage(chatId, '❌ Hall name cannot be empty.');
        return true;
      }

      const result = await addHall(hallName);
      await bot.sendMessage(chatId, result.message);
      await clearAdminState(userId);

      const halls = await getHalls();
      await updateMenuMessage(bot, chatId, userId, menuTexts.manageHallsText(halls), keyboards.manageHallsKeyboard());
      await refreshPreorderPost(bot);
      return true;
    }

    return false;
  }

  if (state.mode === STATES.EDIT_FOOD_STOCK_SPECIFIC) {
    const newStock = Number.parseInt(text, 10);

    if (Number.isNaN(newStock) || newStock < 0) {
      await bot.sendMessage(chatId, '❌ Invalid stock level. Please enter a non-negative number.');
      return true;
    }

    const beforeItem = (await getFoodItems()).find(item => item.id === state.foodItemId);

    const result = await updateFoodItemStock(state.foodItemId, newStock);
    await bot.sendMessage(chatId, result.message);
    await clearAdminState(userId);

    const foodItems = await getFoodItems();
    await updateMenuMessage(
      bot, chatId, userId,
      menuTexts.manageFoodItemsText(foodItems),
      keyboards.manageFoodItemsKeyboard()
    );

    await refreshPreorderPostAfterStockChange(
      bot,
      beforeItem ? [{ name: beforeItem.name, oldStock: beforeItem.stock || 0, newStock }] : []
    );
    await refreshDeliveryModeMenus(bot);
    return true;
  }

  if (state.mode === STATES.EDIT_ALL_FOOD_STOCK_LOOP) {
    const newStock = Number.parseInt(text, 10);

    if (Number.isNaN(newStock) || newStock < 0) {
      await bot.sendMessage(chatId, '❌ Invalid stock level. Please enter a non-negative number.');
      return true;
    }

    const currentItem = state.items[state.currentIndex];
    await updateFoodItemStock(currentItem.id, newStock);

    const nextIndex = state.currentIndex + 1;

    if (nextIndex < state.items.length) {
      const nextItem = state.items[nextIndex];
      await setAdminState(userId, { ...state, currentIndex: nextIndex });
      await updateMenuMessage(
        bot, chatId, userId,
        menuTexts.editStockPromptText(nextItem.name, nextItem.stock || 0, nextIndex + 1, state.items.length),
        keyboards.cancelStockEditKeyboard()
      );
      return true;
    }

    await bot.sendMessage(chatId, menuTexts.updateCompleteText(state.items.length));
    await clearAdminState(userId);

    const updatedItems = await getFoodItems();
    await updateMenuMessage(
      bot, chatId, userId,
      menuTexts.manageFoodItemsText(updatedItems),
      keyboards.manageFoodItemsKeyboard()
    );

    // state.items is the snapshot from before this whole session started, so
    // this compares against every item's true starting stock, not just the
    // one edited last.
    const changes = state.items.map(original => {
      const updated = updatedItems.find(item => item.id === original.id);
      return { name: original.name, oldStock: original.stock || 0, newStock: updated ? (updated.stock || 0) : 0 };
    });

    await refreshPreorderPostAfterStockChange(bot, changes);
    await refreshDeliveryModeMenus(bot);
    return true;
  }

  return false;
}


// --- Callbacks ---------------------------------------------------------------

async function handleAdminCallback(bot, query) {
  const chatId = query.message.chat.id;
  const userId = query.from.id;
  const data = query.data;
  const messageId = query.message.message_id;

  if (!isAdmin(userId)) {
    return false;
  }

  if (isCallbackType(data, CALLBACKS.ORDER_CONFIRM_PREFIX)) {
    return handleOrderConfirm(bot, query, chatId, userId, messageId, data);
  }

  if (isCallbackType(data, CALLBACKS.ORDER_REJECT_PREFIX)) {
    return handleOrderReject(bot, query, chatId, userId, messageId, data);
  }

  if (isCallbackType(data, CALLBACKS.PAYMENT_ACCEPT_PREFIX)) {
    return handlePaymentAccept(bot, query, chatId, userId, messageId, data);
  }

  if (isCallbackType(data, CALLBACKS.PAYMENT_REJECT_PREFIX)) {
    return handlePaymentReject(bot, query, chatId, userId, messageId, data);
  }

  return handleMenuCallback(bot, query, chatId, userId, messageId, data);
}

/**
 * Run an order action under a per-order lock.
 *
 * Replaces the in-memory orderActionInFlight Set, which only guarded one
 * instance. The conditional status transitions inside are the real safety net;
 * this lock just avoids two admins doing redundant Sheets work.
 */
async function withOrderLock(bot, query, orderId, task) {
  let holder = null;

  try {
    holder = await stateStore.acquireLock(stateStore.LOCKS.orderAction(orderId), { leaseMs: 30000 });

    if (!holder) {
      await bot.answerCallbackQuery(query.id, { text: 'Another admin action is in progress for this order.' });
      return true;
    }

    return await task();
  } finally {
    if (holder) {
      await stateStore.releaseLock(stateStore.LOCKS.orderAction(orderId), holder);
    }
  }
}

async function handleOrderConfirm(bot, query, chatId, userId, messageId, data) {
  // DO NOT DELETE: legacy order approval, retained for existing pending orders
  // and possible re-enabling. New checkout orders go straight to payment.
  const orderId = extractCallbackValue(data, CALLBACKS.ORDER_CONFIRM_PREFIX);

  return withOrderLock(bot, query, orderId, async () => {
    const order = await orderStore.getPendingOrder(orderId);

    if (!order) {
      await bot.answerCallbackQuery(query.id, { text: 'Order not found', show_alert: true });
      return true;
    }

    if (order.status !== STATUS.PENDING_ADMIN_CONFIRMATION) {
      await bot.answerCallbackQuery(query.id, { text: `Order already ${order.status}`, show_alert: true });
      return true;
    }

    const confirmed = await orderStore.confirmPendingOrder(orderId, userId);

    if (!confirmed) {
      await bot.answerCallbackQuery(query.id, { text: 'Order is already handled', show_alert: true });
      return true;
    }

    await editMessageTextSafely(bot, `${query.message.text}\n\n✅ Status: Confirmed by admin ${userId}`, {
      chat_id: chatId,
      message_id: messageId,
    }).catch(() => {});

    await sendPaymentInstructions(bot, confirmed);
    await refreshDeliveryModeMenus(bot);
    await refreshPreorderPost(bot);

    await bot.answerCallbackQuery(query.id, { text: 'Order confirmed' });
    return true;
  });
}

/**
 * Send the PayNow instruction image and the amount due.
 *
 * PAYMENT_INSTRUCTION_IMAGE may be a Telegram file_id, an https URL or a local
 * path, and all three are accepted. After the first successful send the
 * resulting file_id is cached, so later sends skip the upload entirely and no
 * longer depend on the file being bundled into the deployment.
 */
function buildPaymentCaption(order) {
  const heading = `✅ Order ${order.code} placed\n🏢 Hall: ${order.hallName}\n\n`;
  const instructions = `\n\n💰 Amount due: ${formatCents(order.totalCents)}\n\n`
    + 'Please use PayNow to pay using the QR above.\n\n'
    + 'Send an UNCROPPED screenshot of the completed transfer for automatic verification. You can send it as a photo or file.\n\n'
    + 'MUST INCLUDE DATE, TIME AND PAYMENT AMOUNT AND TO WHO\n\n'
    + '📸 Swipe for an example of a valid screenshot.\n\n'
    + (config.payment.expiryEnabled ? `⚠️ Pay within ${config.payment.windowMinutes} minutes.` : 'Please send your receipt after payment.');
  const summary = orderActions.buildOrderSummary(order);
  const suffix = '\n… Full order: /orders';
  // Telegram photo captions allow 1024 characters. Keep payment details intact.
  const budget = Math.max(0, 1024 - heading.length - instructions.length);
  let displayed = summary;
  if (summary.length > budget) {
    displayed = '';
    for (const char of summary) {
      if (displayed.length + char.length > budget - suffix.length) break;
      displayed += char;
    }
    displayed += suffix;
  }
  return heading + displayed + instructions;
}

const PAYMENT_EXAMPLE_IMAGE = 'src/payment_example.png';
const PAYMENT_EXAMPLE_CAPTION = '📸 Example of a valid screenshot — yours should show the date, time, amount and who it was paid to, just like this:';

/**
 * Generate this order's PayNow QR (amount and order code baked in) as a media
 * item, ready to go alongside the example screenshot in one album.
 *
 * Returns null whenever a QR can't be produced - no UEN/mobile configured, or
 * the encoder itself failed - so the caller falls back to the static image.
 */
async function buildDynamicQrMedia(order, caption) {
  let buffer;
  try {
    buffer = await paynowQr.generatePayNowQrPng({
      uen: config.payment.uen,
      mobile: config.payment.proxyNumber,
      amountCents: order.totalCents,
      merchantName: config.payment.merchantName,
      reference: order.code,
    });
  } catch (error) {
    log('warn', 'paynow_qr_generate_failed', { order_code: order.code, error: error.message });
    return null;
  }

  if (!buffer) {
    // Distinguishable from a generation error above: this is "no PayNow
    // identity configured" (config.payment.uen/proxyNumber both empty at
    // request time), which is otherwise silent and easy to mistake for the
    // encoder having failed.
    log('warn', 'paynow_qr_no_identity_configured', { order_code: order.code });
    return null;
  }

  return {
    type: 'photo',
    media: buffer,
    caption,
    fileOptions: { filename: 'paynow-qr.png', contentType: 'image/png' },
  };
}

/**
 * The example-screenshot media item, reusing a previously uploaded file_id
 * when one is cached so the album doesn't re-upload the same image forever.
 *
 * Deliberately uncaptioned: Telegram only renders an album's caption when
 * exactly one item in the group has one, so the QR's caption (the actual
 * payment instructions) would silently disappear if this item had its own
 * too. The "swipe for an example" line lives in that caption instead.
 */
async function buildExampleMedia() {
  let cachedFileId = null;
  try {
    cachedFileId = await stateStore.get(stateStore.KEYS.paymentExampleImageFileId(), null);
  } catch (error) {
    log('warn', 'payment_example_cache_read_failed', { error: error.message });
  }

  return {
    item: {
      type: 'photo',
      media: cachedFileId || resolveImageSource(PAYMENT_EXAMPLE_IMAGE),
    },
    cached: Boolean(cachedFileId),
  };
}

async function cacheExampleFileId(examplePhoto) {
  if (!examplePhoto?.length) {
    return;
  }
  try {
    await stateStore.set(
      stateStore.KEYS.paymentExampleImageFileId(),
      examplePhoto[examplePhoto.length - 1].file_id,
      { ttlMs: 30 * 24 * 60 * 60 * 1000 }
    );
  } catch (error) {
    log('warn', 'payment_example_cache_write_failed', { error: error.message });
  }
}

async function cacheQrFileId(qrPhoto) {
  if (!qrPhoto?.length) {
    return;
  }
  try {
    await stateStore.set(
      stateStore.KEYS.paymentImageFileId(),
      qrPhoto[qrPhoto.length - 1].file_id,
      { ttlMs: 30 * 24 * 60 * 60 * 1000 }
    );
  } catch (error) {
    log('warn', 'payment_image_cache_write_failed', { error: error.message });
  }
}

/**
 * Send one QR candidate paired with the example as a two-photo album.
 *
 * If a cached example file_id is what Telegram rejected, retries once with a
 * fresh upload of the local example file before giving up on this QR - a
 * stale example reference must never be the reason the customer loses the
 * payment QR too.
 *
 * Returns the two sent messages on success (and caches any freshly uploaded
 * example file_id) so the caller can still cache the QR's own file_id.
 * Returns null without throwing so the caller can fall back further.
 */
async function sendGalleryAttempt(bot, order, qrMedia, exampleState, logEvent) {
  let example = exampleState;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    let sent;
    try {
      sent = await bot.sendMediaGroup(order.chatId, [qrMedia, example.item]);
    } catch (error) {
      log('warn', logEvent, { order_code: order.code, error: error.message });

      if (attempt === 0 && example.cached) {
        example = {
          item: { ...example.item, media: resolveImageSource(PAYMENT_EXAMPLE_IMAGE) },
          cached: false,
        };
        continue;
      }

      return null;
    }

    if (!example.cached) {
      await cacheExampleFileId(sent[1]?.photo);
    }
    return sent;
  }

  return null;
}

/**
 * Deliver one QR candidate: try it in the gallery album with the example
 * first, then - if the album itself can't go out - send the QR alone (never
 * blocked on the example) and attempt the example separately, best-effort.
 *
 * Returns `{ delivered, qrPhoto }`. `qrPhoto` is only set when the QR was
 * freshly uploaded (not sent by a cached file_id or Buffer that isn't worth
 * caching), for the caller to cache.
 */
async function sendQrCandidate(bot, order, qrMedia, exampleState, logEvent) {
  const gallerySent = await sendGalleryAttempt(bot, order, qrMedia, exampleState, logEvent);
  if (gallerySent) {
    return { delivered: true, qrPhoto: gallerySent[0]?.photo };
  }

  let sent;
  try {
    sent = await bot.sendPhoto(order.chatId, qrMedia.media, { caption: qrMedia.caption }, qrMedia.fileOptions);
  } catch (error) {
    log('warn', logEvent, { order_code: order.code, error: error.message });
    return { delivered: false };
  }

  await sendPaymentExampleBestEffort(bot, order.chatId, exampleState);
  return { delivered: true, qrPhoto: sent?.photo };
}

/**
 * Send the QR and the example screenshot together as one album, so the
 * customer swipes between them in the same gallery instead of getting two
 * separate messages.
 *
 * Prefers the per-order dynamic PayNow QR; if it can't be delivered at all -
 * built or sent, alone or with the example - falls back through the
 * configured static QR image sources the same way.
 */
async function sendPaymentInstructions(bot, order) {
  const caption = buildPaymentCaption(order);
  const exampleState = await buildExampleMedia();

  const dynamicQr = await buildDynamicQrMedia(order, caption);
  if (dynamicQr) {
    // Never cached - the amount and reference differ on every order.
    const { delivered } = await sendQrCandidate(bot, order, dynamicQr, exampleState, 'payment_gallery_send_failed');
    if (delivered) {
      return;
    }
  }

  let cachedFileId = null;
  try {
    cachedFileId = await stateStore.get(stateStore.KEYS.paymentImageFileId(), null);
  } catch (error) {
    log('warn', 'payment_image_cache_read_failed', { error: error.message });
  }
  const sources = [...new Set([
    cachedFileId,
    config.telegram.paymentInstructionImage,
    config.telegram.paymentInstructionImageUrl,
  ].filter(Boolean))];

  for (const source of sources) {
    const qrMedia = { type: 'photo', media: resolveImageSource(source), caption };
    const { delivered, qrPhoto } = await sendQrCandidate(bot, order, qrMedia, exampleState, 'payment_instruction_send_failed');

    if (!delivered) {
      continue;
    }

    // A cache failure after delivery must never send a duplicate message.
    if (source !== cachedFileId) {
      await cacheQrFileId(qrPhoto);
    }
    return;
  }

  await orderActions.notify(bot, order.chatId,
    caption.replace('Please use PayNow to pay using the QR above.',
      'Payment image unavailable. Please contact an admin for payment details.'));
}

/**
 * Best-effort follow-up photo showing what a correctly-completed receipt
 * looks like. Only reached once the gallery album itself couldn't be
 * delivered - the real instructions already went out via a lone QR photo, so
 * a failure here is logged and swallowed rather than blocking the order.
 */
async function sendPaymentExampleBestEffort(bot, chatId, exampleState) {
  const sources = [...new Set([
    exampleState.cached ? exampleState.item.media : null,
    resolveImageSource(PAYMENT_EXAMPLE_IMAGE),
  ].filter(Boolean))];

  for (const source of sources) {
    let sent;
    try {
      sent = await bot.sendPhoto(chatId, source, { caption: PAYMENT_EXAMPLE_CAPTION });
    } catch (error) {
      log('warn', 'payment_example_send_failed', { error: error.message });
      continue;
    }
    if (!exampleState.cached) {
      await cacheExampleFileId(sent?.photo);
    }
    return;
  }
}

function resolveImageSource(source) {
  if (/^https?:\/\//i.test(source)) {
    return source;
  }

  // A bare file_id has no path separators or dots; anything else is a path,
  // resolved against the repo root so it works regardless of working directory.
  if (source.includes('/') || source.includes('\\') || source.includes('.')) {
    return require('path').resolve(__dirname, '..', '..', source);
  }

  return source;
}

async function handleOrderReject(bot, query, chatId, userId, messageId, data) {
  const orderId = extractCallbackValue(data, CALLBACKS.ORDER_REJECT_PREFIX);

  return withOrderLock(bot, query, orderId, async () => {
    const order = await orderStore.getPendingOrder(orderId);

    if (!order) {
      await bot.answerCallbackQuery(query.id, { text: 'Order not found', show_alert: true });
      return true;
    }

    if (order.status !== STATUS.PENDING_ADMIN_CONFIRMATION) {
      await bot.answerCallbackQuery(query.id, { text: `Order already ${order.status}`, show_alert: true });
      return true;
    }

    const result = await orderActions.rejectOrderAndRestock(bot, order, {
      fromStatus: STATUS.PENDING_ADMIN_CONFIRMATION,
      actor: 'admin',
      actorTelegramId: userId,
      reason: 'Rejected by admin',
      customerMessage: `❌ Your order ${order.code} was rejected. `
        + `The order has been sent too late or there was an issue with the order.\n\n`
        + `Please restart your order by typing /start`,
    });

    if (!result.success) {
      await bot.answerCallbackQuery(query.id, { text: result.message || 'Failed to reject order', show_alert: true });
      return true;
    }

    await editMessageTextSafely(
      bot,
      `${query.message.text}\n\n❌ Status: Rejected by admin ${userId}\n↩️ Stock restored`,
      { chat_id: chatId, message_id: messageId }
    ).catch(() => {});

    await refreshDeliveryModeMenus(bot);
    await refreshPreorderPost(bot);

    await bot.answerCallbackQuery(query.id, { text: 'Order rejected and stock restored' });
    return true;
  });
}

async function handlePaymentAccept(bot, query, chatId, userId, messageId, data) {
  const orderId = extractCallbackValue(data, CALLBACKS.PAYMENT_ACCEPT_PREFIX);

  return withOrderLock(bot, query, orderId, async () => {
    const order = await orderStore.getPendingOrder(orderId);

    if (!order) {
      await bot.answerCallbackQuery(query.id, { text: 'Order not found', show_alert: true });
      return true;
    }

    // SERVED is included so an order handed over before payment cleared
    // (see orderStore.markOrderServed) can still be reconciled afterwards -
    // this is the only way to ever mark such an order paid.
    const payable = [STATUS.PAYMENT_FLAGGED, STATUS.AWAITING_PAYMENT, STATUS.VERIFYING_PAYMENT, STATUS.SERVED];

    if (!payable.includes(order.status)) {
      await bot.answerCallbackQuery(query.id, { text: `Order already ${order.status}`, show_alert: true });
      return true;
    }

    // Same shared function the automatic approval uses, so the two paths cannot
    // diverge in what they tell the customer or what they update.
    const paid = await orderActions.markOrderPaid(bot, order, {
      fromStatus: order.status,
      actor: 'admin',
      actorTelegramId: userId,
      reason: 'Payment accepted by admin',
    });

    if (!paid) {
      await bot.answerCallbackQuery(query.id, { text: 'Order was already handled', show_alert: true });
      return true;
    }

    await recordManualReview(orderId, userId, 'manually_approved');
    await updateReviewMessage(bot, query, chatId, messageId, `\n\n✅ Payment accepted by admin ${userId}`);
    await refreshDeliveryModeMenus(bot);

    await bot.answerCallbackQuery(query.id, { text: 'Payment accepted' });
    return true;
  });
}

async function handlePaymentReject(bot, query, chatId, userId, messageId, data) {
  const orderId = extractCallbackValue(data, CALLBACKS.PAYMENT_REJECT_PREFIX);

  return withOrderLock(bot, query, orderId, async () => {
    const order = await orderStore.getPendingOrder(orderId);

    if (!order) {
      await bot.answerCallbackQuery(query.id, { text: 'Order not found', show_alert: true });
      return true;
    }

    const rejectable = [STATUS.PAYMENT_FLAGGED, STATUS.AWAITING_PAYMENT, STATUS.VERIFYING_PAYMENT];

    if (!rejectable.includes(order.status)) {
      await bot.answerCallbackQuery(query.id, { text: `Order already ${order.status}`, show_alert: true });
      return true;
    }

    const result = await orderActions.rejectOrderAndRestock(bot, order, {
      fromStatus: order.status,
      actor: 'admin',
      actorTelegramId: userId,
      reason: 'Payment rejected by admin',
      customerMessage: `❌ Payment for Order ${order.code} was rejected.\n\n`
        + `Please restart your order by typing /start`,
    });

    if (!result.success) {
      await bot.answerCallbackQuery(query.id, { text: result.message || 'Failed to reject payment', show_alert: true });
      return true;
    }

    await recordManualReview(orderId, userId, 'manually_rejected');
    await updateReviewMessage(
      bot, query, chatId, messageId,
      `\n\n❌ Payment rejected by admin ${userId}\n↩️ Stock restored`
    );
    await refreshDeliveryModeMenus(bot);
    // The order was in the active set (payment_flagged/awaiting/verifying),
    // so it may be sitting in a hall's cached "we are here" list - drop it
    // now rather than waiting for the next unrelated order at that hall.
    await refreshHallServeOrdersMessage(bot, order.hallName);

    await bot.answerCallbackQuery(query.id, { text: 'Payment rejected and stock restored' });
    return true;
  });
}

/** Attribute a manual decision to the reviewing admin in the audit trail. */
async function recordManualReview(orderId, adminId, outcome) {
  try {
    const { getSupabase, unwrap } = require('../services/supabase');
    const supabase = getSupabase();

    const rows = unwrap(
      await supabase
        .from('payment_submissions')
        .select('id')
        .eq('order_id', orderId)
        .order('received_at', { ascending: false })
        .limit(1),
      'recordManualReview'
    );

    if (rows.length) {
      await repo.updatePaymentSubmission(rows[0].id, {
        outcome,
        reviewed_by_telegram_id: adminId,
        reviewed_at: new Date().toISOString(),
      });
    }
  } catch (error) {
    log('warn', 'record_manual_review_failed', { error: error.message });
  }
}

/** The review message is a photo when a receipt exists, otherwise plain text. */
async function updateReviewMessage(bot, query, chatId, messageId, suffix) {
  const options = { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } };

  try {
    if (query.message.caption) {
      await editMessageCaptionSafely(bot, `${query.message.caption}${suffix}`, options);
    } else {
      await editMessageTextSafely(bot, `${query.message.text || ''}${suffix}`, options);
    }
  } catch (error) {
    log('warn', 'update_review_message_failed', { error: error.message });
  }
}


// --- Settings menus (behaviour unchanged) ------------------------------------

async function handleMenuCallback(bot, query, chatId, userId, messageId, data) {
  const answer = (text, options) => bot.answerCallbackQuery(query.id, { ...options, text });

  if (data === CALLBACKS.ADMIN_SETTINGS) {
    await updateMenuMessage(bot, chatId, userId, menuTexts.settingsMenuText(), keyboards.settingsMenuKeyboard());
    await answer();
    return true;
  }

  if (data === CALLBACKS.ADMIN_STATS) {
    await updateMenuMessage(
      bot, chatId, userId,
      menuTexts.adminStatsText(getAdminIds().length),
      keyboards.backToMainMenuKeyboard()
    );
    await answer();
    return true;
  }

  if (data === CALLBACKS.ADMIN_RELOAD) {
    const success = await reloadAdminIds();
    await updateMenuMessage(bot, chatId, userId, menuTexts.reloadText(success), keyboards.backToMainMenuKeyboard());
    await answer();
    return true;
  }

  if (data === CALLBACKS.SETTINGS_MANAGE_ADMINS) {
    await reloadAdminIds();
    const tagId = await getPreorderAdminTag();
    const tagUsername = tagId ? await getAdminUsernameById(bot, tagId) : null;

    await updateMenuMessage(
      bot, chatId, userId,
      menuTexts.manageAdminsText(userId, getAdminIds().join('\n'), tagId, tagUsername),
      keyboards.manageAdminsKeyboard()
    );
    await answer();
    return true;
  }

  if (data === CALLBACKS.MANAGE_ADD_ADMIN) {
    await setAdminState(userId, STATES.ADD_ADMIN);
    await updateMenuMessage(bot, chatId, userId, menuTexts.addAdminPromptText(), keyboards.addAdminKeyboard());
    await answer();
    return true;
  }

  if (data === CALLBACKS.MANAGE_DELETE_ADMIN) {
    await updateMenuMessage(
      bot, chatId, userId,
      menuTexts.deleteAdminSelectText(),
      keyboards.adminListKeyboard(getAdminIds())
    );
    await answer();
    return true;
  }

  if (isCallbackType(data, CALLBACKS.DELETE_ADMIN_PREFIX)) {
    const adminId = Number.parseInt(extractCallbackValue(data, CALLBACKS.DELETE_ADMIN_PREFIX), 10);
    const result = await deleteAdmin(adminId);
    await updateMenuMessage(bot, chatId, userId, result.message, keyboards.addAdminKeyboard());
    await answer();
    return true;
  }

  if (data === CALLBACKS.SETTINGS_SET_ADMIN_TAG) {
    await reloadAdminIds();
    const adminIds = getAdminIds();

    if (adminIds.length === 0) {
      await updateMenuMessage(
        bot, chatId, userId,
        'No admins available to set as tag admin.',
        keyboards.backToMainMenuKeyboard()
      );
      await answer();
      return true;
    }

    const adminList = await Promise.all(
      adminIds.map(async id => ({ id, username: await getAdminUsernameById(bot, id) }))
    );
    const currentTagId = await getPreorderAdminTag();
    const current = adminList.find(admin => admin.id === currentTagId);

    await updateMenuMessage(
      bot, chatId, userId,
      menuTexts.setAdminToTagText(currentTagId, current && current.username),
      keyboards.selectAdminToTagKeyboard(adminList, currentTagId)
    );
    await answer();
    return true;
  }

  if (isCallbackType(data, CALLBACKS.SET_ADMIN_TAG_PREFIX)) {
    const selectedId = Number.parseInt(extractCallbackValue(data, CALLBACKS.SET_ADMIN_TAG_PREFIX), 10);
    const saved = await writeToSheet('Settings!B2', [[selectedId]]);

    if (!saved) {
      await answer('✗ Failed to set admin to tag', { show_alert: true });
      return true;
    }

    const username = await getAdminUsernameById(bot, selectedId);
    await answer(`✓ Admin to tag set to ${selectedId} ${username ? `@${username}` : ''}`);

    const adminList = await Promise.all(
      getAdminIds().map(async id => ({ id, username: await getAdminUsernameById(bot, id) }))
    );

    await updateMenuMessage(
      bot, chatId, userId,
      menuTexts.setAdminToTagText(selectedId, username),
      keyboards.selectAdminToTagKeyboard(adminList, selectedId)
    );
    await refreshPreorderPost(bot);
    return true;
  }

  if (data === CALLBACKS.SETTINGS_MANAGE_FOODS) {
    const foodItems = await getFoodItems();
    await updateMenuMessage(
      bot, chatId, userId,
      menuTexts.manageFoodItemsText(foodItems),
      keyboards.manageFoodItemsKeyboard()
    );
    await answer();
    return true;
  }

  if (data === CALLBACKS.FOOD_ADD) {
    await setAdminState(userId, 'add_food_item');
    await updateMenuMessage(bot, chatId, userId, menuTexts.addFoodItemPromptText(), keyboards.addFoodItemKeyboard());
    await answer();
    return true;
  }

  if (data === CALLBACKS.FOOD_DELETE) {
    const foodItems = await getFoodItems();

    if (foodItems.length === 0) {
      await updateMenuMessage(bot, chatId, userId, menuTexts.noFoodItemsText(), keyboards.backToFoodMenuKeyboard());
      await answer();
      return true;
    }

    await updateMenuMessage(
      bot, chatId, userId,
      menuTexts.deleteFoodSelectText(),
      keyboards.foodItemsDeleteKeyboard(foodItems)
    );
    await answer();
    return true;
  }

  if (isCallbackType(data, CALLBACKS.FOOD_DELETE_PREFIX)) {
    const [idValue, token] = extractCallbackValue(data, CALLBACKS.FOOD_DELETE_PREFIX).split(':');
    const foodItemId = Number.parseInt(idValue, 10);

    if (Number.isNaN(foodItemId) || !token) {
      await answer('This delete menu is outdated. Reopen Delete Food list.', { show_alert: true });
      return true;
    }

    // The token guards against row numbers shifting between rendering the menu
    // and tapping it, which would otherwise delete the wrong item.
    const liveItem = (await getFoodItems()).find(item => item.id === foodItemId);

    if (!liveItem || createCallbackItemToken(liveItem.name) !== token) {
      await answer('This delete button is outdated. Reopen Delete Food list.', { show_alert: true });
      return true;
    }

    const result = await deleteFoodItem(foodItemId);
    await updateMenuMessage(bot, chatId, userId, result.message, keyboards.backToFoodMenuKeyboard());
    await answer();
    await refreshPreorderPost(bot);
    return true;
  }

  if (data === CALLBACKS.FOOD_EDIT_STOCK) {
    const foodItems = await getFoodItems();

    if (foodItems.length === 0) {
      await updateMenuMessage(bot, chatId, userId, menuTexts.noFoodItemsText(), keyboards.backToFoodMenuKeyboard());
      await answer();
      return true;
    }

    await updateMenuMessage(
      bot, chatId, userId,
      menuTexts.editSpecificStockText(),
      keyboards.foodItemsEditStockKeyboard(foodItems)
    );
    await answer();
    return true;
  }

  if (isCallbackType(data, CALLBACKS.FOOD_EDIT_STOCK_PREFIX)) {
    const foodItemId = Number.parseInt(extractCallbackValue(data, CALLBACKS.FOOD_EDIT_STOCK_PREFIX), 10);
    await setAdminState(userId, { mode: STATES.EDIT_FOOD_STOCK_SPECIFIC, foodItemId });

    await updateMenuMessage(
      bot, chatId, userId,
      '📊 Enter new stock level for this food item:\n\nReply with a number (e.g., 10)',
      keyboards.cancelStockEditKeyboard()
    );
    await answer();
    return true;
  }

  if (data === CALLBACKS.FOOD_EDIT_ALL_STOCK) {
    const foodItems = await getFoodItems();

    if (foodItems.length === 0) {
      await updateMenuMessage(bot, chatId, userId, menuTexts.noFoodItemsText(), keyboards.backToFoodMenuKeyboard());
      await answer();
      return true;
    }

    const first = foodItems[0];
    await setAdminState(userId, { mode: STATES.EDIT_ALL_FOOD_STOCK_LOOP, items: foodItems, currentIndex: 0 });

    await updateMenuMessage(
      bot, chatId, userId,
      menuTexts.editStockPromptText(first.name, first.stock || 0, 1, foodItems.length),
      keyboards.cancelStockEditKeyboard()
    );
    await answer();
    return true;
  }

  if (data === CALLBACKS.SETTINGS_MANAGE_HALLS) {
    await updateMenuMessage(
      bot, chatId, userId,
      menuTexts.manageHallsText(await getHalls()),
      keyboards.manageHallsKeyboard()
    );
    await answer();
    return true;
  }

  if (data === CALLBACKS.HALL_ADD) {
    await setAdminState(userId, STATES.ADD_HALL);
    await updateMenuMessage(bot, chatId, userId, menuTexts.addHallPromptText(), keyboards.addHallKeyboard());
    await answer();
    return true;
  }

  if (data === CALLBACKS.HALL_DELETE) {
    const halls = await getHalls();

    if (halls.length === 0) {
      await updateMenuMessage(bot, chatId, userId, 'No halls to delete.', keyboards.backToHallsKeyboard());
      await answer();
      return true;
    }

    await updateMenuMessage(
      bot, chatId, userId,
      menuTexts.deleteHallSelectText(),
      keyboards.hallsDeleteKeyboard(halls)
    );
    await answer();
    return true;
  }

  if (isCallbackType(data, CALLBACKS.HALL_DELETE_PREFIX)) {
    const [idValue, token] = extractCallbackValue(data, CALLBACKS.HALL_DELETE_PREFIX).split(':');
    const hallId = Number.parseInt(idValue, 10);

    if (Number.isNaN(hallId) || !token) {
      await answer('This delete menu is outdated. Reopen Delete Hall list.', { show_alert: true });
      return true;
    }

    const liveHall = (await getHalls()).find(hall => hall.id === hallId);

    if (!liveHall || createCallbackItemToken(liveHall.name) !== token) {
      await answer('This delete button is outdated. Reopen Delete Hall list.', { show_alert: true });
      return true;
    }

    const result = await deleteHall(hallId);
    await updateMenuMessage(bot, chatId, userId, result.message, keyboards.backToHallsKeyboard());
    await answer();
    await refreshPreorderPost(bot);
    return true;
  }

  if (data === CALLBACKS.ADMIN_MENU_BACK || data === CALLBACKS.DELIVERY_MODE_BACK) {
    await showMainAdminMenu(bot, chatId, userId);
    await answer();
    return true;
  }

  if (data === CALLBACKS.SETTINGS_DELIVERY_MODE) {
    await showDeliveryModeMenu(bot, chatId, userId);
    await answer();
    return true;
  }

  if (isCallbackType(data, CALLBACKS.DELIVERY_MODE_POST_CHANNEL_PREFIX)) {
    return handleDeliveryPost(bot, query, chatId, userId, data);
  }

  if (data === CALLBACKS.DELIVERY_MODE_REVERT_BLOCK) {
    const currentMenuId = await getMenuMessageId(userId);

    if (!currentMenuId || currentMenuId !== messageId) {
      await answer('This delivery menu is outdated. Please use the latest menu.', { show_alert: true });
      return true;
    }

    const reverted = await orderStore.revertLastBlockedHall();

    if (!reverted) {
      await answer('No blocked hall to revert', { show_alert: true });
      return true;
    }

    await refreshPreorderPost(bot);
    await refreshDeliveryModeMenus(bot);
    await answer(`Reverted ${reverted}`);
    return true;
  }

  if (isCallbackType(data, CALLBACKS.DELIVERY_MODE_SERVE_CUSTOMER_PREFIX)) {
    return handleServeCustomerOpen(bot, query, chatId, messageId, data);
  }

  if (isCallbackType(data, CALLBACKS.DELIVERY_MODE_SERVE_BACK_PREFIX)) {
    return handleServeBack(bot, query, chatId, messageId, data);
  }

  if (isCallbackType(data, CALLBACKS.DELIVERY_MODE_SERVE_REMAINING_PREFIX)) {
    return handleServeRemainingOpen(bot, query, chatId, messageId, data);
  }

  if (isCallbackType(data, CALLBACKS.DELIVERY_MODE_SERVE_DROPOFF_PREFIX)) {
    return handleServeDropoffStart(bot, query, chatId, messageId, data);
  }

  if (isCallbackType(data, CALLBACKS.DELIVERY_MODE_SERVE_MARK_SERVED_PREFIX)) {
    return handleServeMarkOrder(bot, query, chatId, messageId, data, 'served');
  }

  if (isCallbackType(data, CALLBACKS.DELIVERY_MODE_SERVE_MARK_DROPPED_PREFIX)) {
    return handleServeMarkOrder(bot, query, chatId, messageId, data, 'dropped_off');
  }

  if (data === CALLBACKS.DELIVERY_MODE_FINISH) {
    return handleFinishDelivery(bot, query, chatId, userId);
  }

  if (data === CALLBACKS.DELIVERY_MODE_RESET_HALLS) {
    await orderStore.clearBlockedHalls();
    await refreshPreorderPost(bot);
    await refreshDeliveryModeMenus(bot);
    await answer('✅ Halls have been reset.');
    await bot.sendMessage(chatId, '✅ Halls have been reset. Orders are now available to be placed by any halls.');
    return true;
  }

  return false;
}

// --- Delivery automation: hall serve progress drives get-ready/coming ------

// "2/3 of the current hall served" fires the next hall's get-ready post;
// fully served fires its coming post (and closes its ordering - see
// blockHallForAutoClosure).
const GET_READY_THRESHOLD = 2 / 3;

function meetsAutoPostThreshold(mode, fraction) {
  if (mode === 'get-ready') return fraction >= GET_READY_THRESHOLD;
  if (mode === 'coming') return fraction >= 1;
  return false;
}

/**
 * DM every customer with a still-active order at this hall. Best-effort per
 * customer - one blocked bot must not stop the rest from being notified.
 */
async function notifyHallCustomers(bot, hallName, text) {
  const hallOrders = await orderStore.getActiveOrdersByHall(hallName);
  const chatIds = new Set(hallOrders.map(order => order.chatId).filter(Boolean));

  for (const chatId of chatIds) {
    await orderActions.notify(bot, chatId, text);
  }
}

/**
 * Clear out anyone who picked this hall but never confirmed an order - they
 * have nothing in Supabase to protect, just an open cart. Customers already
 * mid-payment are untouched: hall blocking only stops NEW carts/orders (see
 * showOrderScreen in handlers/user.js), it was never going to touch theirs.
 */
async function kickOpenCartsForHall(bot, hallName) {
  const telegramUserIds = await cartStore.getCartsForHall(hallName);

  for (const telegramUserId of telegramUserIds) {
    await cartStore.clearCart(telegramUserId);
    await orderActions.notify(
      bot,
      telegramUserId,
      `⛔ Ordering for ${hallName} has just closed - the delivery is on its way and there's no more time `
      + `to prepare new orders. Your cart has been cleared.\n\nSorry about that! Watch out for the next preorder.`
    );
  }
}

/**
 * Close a hall's ordering the moment the "we are coming" post for it goes
 * out (whether that post was manual or automatic), and clear out anyone
 * caught mid-browse. A no-op if the hall was already blocked - the
 * last-hall-of-the-night wraparound (see autoAdvanceDeliveryStage) can hand
 * this an already-blocked hall, and there is nothing further to do for it.
 */
async function blockHallForAutoClosure(bot, hall) {
  const newlyBlocked = await orderStore.blockHall(hall.name);

  if (!newlyBlocked) {
    return;
  }

  await kickOpenCartsForHall(bot, hall.name);
  await refreshPreorderPost(bot);
}

/**
 * Core channel-post + sequencer-advance logic, shared by the manual admin tap
 * (preorder/here) and the automatic get-ready/coming triggers fired by serve
 * progress. Never throws for an expected failure (stale button, missing
 * channel, a Telegram send error) - callers decide how to surface that.
 */
async function postDingoUpdate(bot, { hallId, postMode, notifyChatId = null }) {
  let holder = null;

  try {
    holder = await stateStore.acquireLock(stateStore.LOCKS.deliveryPost(), { leaseMs: 30000 });

    if (!holder) {
      return { posted: false, reason: 'locked' };
    }

    const halls = await googleSheets.getHalls();
    const hall = halls.find(entry => entry.id === hallId);

    if (!hall || !['preorder', 'coming', 'here', 'get-ready'].includes(postMode)) {
      return { posted: false, reason: 'hall_not_found' };
    }

    if (!await isExpectedNextHallToPost(halls, hallId, postMode)) {
      await refreshDeliveryModeMenus(bot);
      return { posted: false, reason: 'stale' };
    }

    const channelId = config.telegram.dingoChannelId;

    if (!channelId) {
      return { posted: false, reason: 'no_channel' };
    }

    const hallLabel = hall.shortName || hall.name;
    const adminId = await getPreorderAdminTag();
    const adminUsername = adminId ? await getAdminUsernameById(bot, adminId) : null;
    const startUrl = postMode === 'preorder' ? await getBotStartUrl(bot) : '';

    let text;
    if (postMode === 'preorder') {
      text = await buildPreorderMessageText(hallLabel, adminUsername);
    } else if (postMode === 'get-ready') {
      text = `Get ready, ${hallLabel}`;
    } else if (postMode === 'here') {
      text = `${hallLabel}, we are here`;
    } else {
      text = buildComingChannelMessage(hallLabel);
    }

    let sent;
    try {
      const button = buildPreorderStartButton(startUrl);
      const options = postMode === 'preorder'
        ? {
          parse_mode: 'HTML',
          disable_web_page_preview: true,
          ...(button ? { reply_markup: button } : {}),
        }
        : {};

      sent = await bot.sendMessage(channelId, text, options);
    } catch (error) {
      log('error', 'dingo_post_failed', { hall: hallLabel, error: error.message });
      return { posted: false, reason: 'send_failed' };
    }

    const toDelete = await getDingoMsgIdsToDelete(postMode);

    if (postMode === 'preorder') {
      await recordPreorderPost(channelId, sent.message_id);
    } else {
      await recordDingoPost(postMode, sent.message_id);
    }

    for (const msgId of toDelete) {
      try {
        await bot.deleteMessage(channelId, msgId);
      } catch (error) {
        log('warn', 'dingo_delete_failed', { error: error.message });
      }
    }

    await advanceNextHallToPost(halls, hallId, postMode);
    await refreshDeliveryModeMenus(bot);

    if (postMode === 'here' && notifyChatId) {
      const hallOrders = await refreshHallServeOrdersCache(hall.name);

      if (hallOrders.length > 0) {
        const serveMsg = await bot.sendMessage(
          notifyChatId,
          HALL_SERVE_LIST_HEADER(hall.name),
          { reply_markup: buildHallCustomerListKeyboard(hall.name, hallOrders) }
        );
        await recordHallServeMessage(hall.name, notifyChatId, serveMsg.message_id);
      }
    } else if (postMode === 'get-ready') {
      await notifyHallCustomers(
        bot,
        hall.name,
        `🔔 Get ready! The delivery is finishing up the current hall and ${hallLabel} is next. `
        + `Start heading down soon.`
      );
    } else if (postMode === 'coming') {
      await blockHallForAutoClosure(bot, hall);
      await notifyHallCustomers(
        bot,
        hall.name,
        `🚚 We're on our way to ${hallLabel} now! Come down and collect your order.`
      );
    }

    return { posted: true, text, hall, hallLabel };
  } finally {
    if (holder) {
      await stateStore.releaseLock(stateStore.LOCKS.deliveryPost(), holder);
    }
  }
}

/**
 * Fire whatever get-ready/coming posts a hall's serve progress now justifies.
 *
 * Called after every "mark as served" tap, and once right after a "here"
 * post goes out (covering a hall nobody ordered from, whose progress is
 * trivially already 100%). Loops because a hall with very few orders can
 * cross both the 2/3 and 100% thresholds in one tap - without the loop that
 * would post get-ready and then sit waiting for a "mark served" that will
 * never come, since everything is already served.
 *
 * Skips the LAST hall in the list entirely: the sequencer wraps its "next
 * hall" back to the first hall once the last hall's "here" has posted, which
 * is the sign the round is over, not a genuine next hall to warn or block.
 * The admin ends the night with "Finish Delivery" instead.
 */
async function autoAdvanceDeliveryStage(bot, hallName) {
  const halls = await googleSheets.getHalls();
  const hallIndex = halls.findIndex(hall => hall.name === hallName);

  if (hallIndex === -1 || hallIndex === halls.length - 1) {
    return;
  }

  const progress = await orderStore.getHallServeProgress(hallName);

  for (let guard = 0; guard < 3; guard += 1) {
    const { hall: nextHall, mode } = await getNextHallToPostState(halls);

    if (!nextHall || !meetsAutoPostThreshold(mode, progress.fraction)) {
      return;
    }

    const result = await postDingoUpdate(bot, { hallId: nextHall.id, postMode: mode });

    if (!result.posted) {
      // Most likely 'locked' (a concurrent tap/tick got there first) or
      // 'stale' (someone else already advanced past this). Either way,
      // nothing more for this call to do.
      return;
    }
  }
}

async function handleDeliveryPost(bot, query, chatId, userId, data) {
  const [postMode, hallIdValue] = extractCallbackValue(data, CALLBACKS.DELIVERY_MODE_POST_CHANNEL_PREFIX).split(':');
  const hallId = Number.parseInt(hallIdValue, 10);

  const result = await postDingoUpdate(bot, { hallId, postMode, notifyChatId: chatId });

  if (!result.posted) {
    const FAILURE_RESPONSES = {
      locked: { text: 'A delivery update is already being posted.' },
      hall_not_found: { text: 'Hall not found', show_alert: true },
      stale: { text: 'This button is outdated. Please use the latest delivery menu.', show_alert: true },
      no_channel: { text: 'DINGO_CHANNEL_ID is not set in the environment.', show_alert: true },
      send_failed: { text: 'Failed to post to the Dingo channel. Check the channel ID and bot permissions.', show_alert: true },
    };

    await bot.answerCallbackQuery(query.id, FAILURE_RESPONSES[result.reason] || { text: 'Could not post update.', show_alert: true });
    return true;
  }

  await bot.answerCallbackQuery(
    query.id,
    { text: postMode === 'preorder' ? 'Posted preorder availability to Dingo channel.' : `Posted to Dingo channel: ${result.text}` }
  );

  if (postMode === 'here') {
    // The lock from the post above is already released by now, so this is
    // free to take it again for whatever it posts (e.g. a hall nobody
    // ordered from, whose get-ready/coming can fire immediately).
    await autoAdvanceDeliveryStage(bot, result.hall.name);
  }

  return true;
}

/**
 * Tap a phone number: show that customer's orders and their Served/Dropped
 * off/Back buttons, editing the tracked message in place. No extra Supabase
 * round trip in the common case - the order data was already fetched to
 * build the list this button lives on (see loadHallServeOrders).
 */
async function handleServeCustomerOpen(bot, query, chatId, messageId, data) {
  const { hallName, telegramUserId } = decodeCustomerKey(
    extractCallbackValue(data, CALLBACKS.DELIVERY_MODE_SERVE_CUSTOMER_PREFIX)
  );

  const hallOrders = await loadHallServeOrders(hallName);
  const group = groupOrdersByCustomer(hallOrders).find(entry => entry.telegramUserId === telegramUserId);

  if (!group) {
    // Someone else's tap (or the auto-progress trigger) already resolved
    // every order this customer had - refresh back to a current list rather
    // than open an empty submenu.
    await editMessageTextSafely(bot, HALL_SERVE_LIST_HEADER(hallName), {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: buildHallCustomerListKeyboard(hallName, hallOrders),
    });
    await bot.answerCallbackQuery(query.id, { text: 'That customer has no orders left here.' });
    return true;
  }

  await editMessageTextSafely(bot, buildCustomerSubmenuText(group), {
    chat_id: chatId,
    message_id: messageId,
    reply_markup: buildCustomerSubmenuKeyboard(hallName, group),
  });
  await bot.answerCallbackQuery(query.id);
  return true;
}

/** "⬅️ Back" from a customer submenu: return to the phone-number list. */
async function handleServeBack(bot, query, chatId, messageId, data) {
  const hallName = extractCallbackValue(data, CALLBACKS.DELIVERY_MODE_SERVE_BACK_PREFIX);
  const hallOrders = await loadHallServeOrders(hallName);

  await editMessageTextSafely(bot, HALL_SERVE_LIST_HEADER(hallName), {
    chat_id: chatId,
    message_id: messageId,
    reply_markup: buildHallCustomerListKeyboard(hallName, hallOrders),
  });
  await bot.answerCallbackQuery(query.id);
  return true;
}

/** "📦 Drop Remaining Items Off": the collated totals + a phone|handle list. */
async function handleServeRemainingOpen(bot, query, chatId, messageId, data) {
  const hallName = extractCallbackValue(data, CALLBACKS.DELIVERY_MODE_SERVE_REMAINING_PREFIX);
  const hallOrders = await loadHallServeOrders(hallName);

  await editMessageTextSafely(bot, buildRemainingItemsText(hallName, hallOrders), {
    chat_id: chatId,
    message_id: messageId,
    reply_markup: buildRemainingItemsKeyboard(hallName, hallOrders),
  });
  await bot.answerCallbackQuery(query.id);
  return true;
}

/**
 * Tapping a customer on the remaining-items screen starts the photo relay:
 * records what to do with the admin's next photo, and asks for it. The
 * screen itself is left as-is - the prompt is a separate message, same
 * pattern as the admin's other multi-step text prompts.
 */
async function handleServeDropoffStart(bot, query, chatId, messageId, data) {
  const { hallName, telegramUserId } = decodeCustomerKey(
    extractCallbackValue(data, CALLBACKS.DELIVERY_MODE_SERVE_DROPOFF_PREFIX)
  );

  const hallOrders = await loadHallServeOrders(hallName);
  const group = groupOrdersByCustomer(hallOrders).find(entry => entry.telegramUserId === telegramUserId);

  if (!group) {
    const refreshed = await refreshHallServeOrdersCache(hallName);
    await editMessageTextSafely(bot, buildRemainingItemsText(hallName, refreshed), {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: buildRemainingItemsKeyboard(hallName, refreshed),
    }).catch(() => {});
    await bot.answerCallbackQuery(query.id, { text: 'That customer has no orders left here.' });
    return true;
  }

  await stateStore.set(
    stateStore.KEYS.awaitingDropoffPhoto(query.from.id),
    {
      hallName,
      telegramUserId,
      customerChatId: group.orders[0].chatId,
      orderIds: group.orders.map(order => order.id),
    },
    { ttlMs: 15 * 60 * 1000 }
  );

  const itemLines = group.orders.map(formatOrderItems).join('; ');

  await bot.sendMessage(
    chatId,
    `📸 Send a photo showing where you left ${group.handle}'s order:\n\n${itemLines}\n\n`
    + `I'll forward it to them and mark ${group.orders.length > 1 ? 'their orders' : 'the order'} dropped off.`
  );

  await bot.answerCallbackQuery(query.id);
  return true;
}

/**
 * The admin's reply to the prompt above: relay the photo to the customer,
 * delete it from the admin's own chat so a night's worth of drop-offs don't
 * clutter it up, then mark every order it covers dropped off.
 *
 * Returns false (not handled) when there is no pending drop-off for this
 * sender, or the message isn't actually an image - dispatch then falls
 * through to the normal payment-receipt handling.
 */
async function handleAdminDropoffPhoto(bot, msg) {
  const adminId = msg.from.id;
  const chatId = msg.chat.id;

  const pending = await stateStore.get(stateStore.KEYS.awaitingDropoffPhoto(adminId), null);

  if (!pending) {
    return false;
  }

  const fileId = msg.photo && msg.photo.length
    ? msg.photo[msg.photo.length - 1].file_id
    : (isImageDocument(msg.document) ? msg.document.file_id : null);

  if (!fileId) {
    return false;
  }

  try {
    await bot.sendPhoto(pending.customerChatId, fileId, {
      caption: "📦 Your order has been dropped off! Here's where to find it.",
    });
  } catch (error) {
    log('warn', 'dropoff_photo_relay_failed', { error: error.message, telegram_user_id: pending.telegramUserId });
    await bot.sendMessage(
      chatId,
      "❌ Could not send that photo to the customer. Please try again, or check they haven't blocked the bot."
    );
    return true;
  }

  // The photo has already been relayed - keeping a copy here too would just
  // fill the admin's chat with a night's worth of drop-off photos.
  try {
    await bot.deleteMessage(chatId, msg.message_id);
  } catch (error) {
    log('warn', 'dropoff_photo_delete_failed', { error: error.message });
  }

  await stateStore.remove(stateStore.KEYS.awaitingDropoffPhoto(adminId));

  const marked = [];
  for (const orderId of pending.orderIds) {
    // Fresh-checked per order, same as any other markOrderServed call - one
    // already resolved elsewhere in the meantime is just skipped, not an error.
    const served = await orderStore.markOrderServed(orderId, adminId, { kind: 'dropped_off' });

    if (served) {
      marked.push(served);
      await autoAdvanceDeliveryStage(bot, served.hallName);

      if (served.wasUnpaid) {
        await notifyAdminsServedUnpaid(bot, served);
      }
    }
  }

  await refreshHallServeOrdersMessage(bot, pending.hallName);
  await refreshDeliveryModeMenus(bot);

  await bot.sendMessage(
    chatId,
    marked.length
      ? `✅ Sent and marked ${marked.map(order => order.code).join(', ')} as dropped off.`
      : '⚠️ Sent the photo, but none of those orders were still active to mark (already handled elsewhere).'
  );

  return true;
}

const SERVE_CUSTOMER_MESSAGE = {
  served: (order, contact) => `✅ Your order ${order.code} has been handed to you, enjoy!${
    order.wasUnpaid
      ? `\n\n⚠️ Payment for this order is still pending. Please complete it if you haven't, `
        + `or contact ${contact} if you've already paid and this looks like a mistake.`
      : ''
  }`,
  dropped_off: (order, contact) => `📦 Your order ${order.code} was dropped off - please come collect it.${
    order.wasUnpaid
      ? `\n\n⚠️ Payment for this order is still pending. Please complete it if you haven't, `
        + `or contact ${contact} if you've already paid and this looks like a mistake.`
      : ''
  }`,
};

/** "✅ Served" / "📦 Dropped off" on one order within a customer's submenu. */
async function handleServeMarkOrder(bot, query, chatId, messageId, data, kind) {
  const prefix = kind === 'served'
    ? CALLBACKS.DELIVERY_MODE_SERVE_MARK_SERVED_PREFIX
    : CALLBACKS.DELIVERY_MODE_SERVE_MARK_DROPPED_PREFIX;
  const orderId = extractCallbackValue(data, prefix);

  const served = await orderStore.markOrderServed(orderId, query.from.id, { kind });

  if (!served) {
    await bot.answerCallbackQuery(query.id, { text: 'Order is already served or no longer active.' });
    return true;
  }

  try {
    const tagId = await googleSheets.getPreorderAdminTag();
    const tagUsername = tagId ? await googleSheets.getAdminUsernameById(bot, tagId) : null;
    const contact = tagUsername ? `@${tagUsername}` : 'the admin';

    await bot.sendMessage(served.chatId, SERVE_CUSTOMER_MESSAGE[kind](served, contact));
  } catch (error) {
    log('warn', 'serve_notify_failed', { order_code: served.code, error: error.message });
  }

  if (served.wasUnpaid) {
    await notifyAdminsServedUnpaid(bot, served);
  }

  // This is the main trigger for get-ready/coming: check whether the hall
  // just crossed a serve-progress threshold now that one more order is done.
  await autoAdvanceDeliveryStage(bot, served.hallName);

  const hallOrders = await refreshHallServeOrdersCache(served.hallName);

  if (hallOrders.length === 0) {
    await editMessageTextSafely(
      bot,
      `${HALL_SERVE_LIST_HEADER(served.hallName)}\n\n✅ All orders in this list have been served.`,
      { chat_id: chatId, message_id: messageId }
    ).catch(() => {});

    // Only drop the tracked ref if it still points at this message - a later
    // "here" post for the same hall may already have replaced it.
    const tracked = await getHallServeMessage(served.hallName);
    if (tracked && tracked.messageId === messageId) {
      await clearHallServeMessage(served.hallName);
    }
  } else {
    const remainingForCustomer = hallOrders.filter(order => order.userId === served.userId);

    if (remainingForCustomer.length > 0) {
      const group = groupOrdersByCustomer(remainingForCustomer)[0];
      await editMessageTextSafely(bot, buildCustomerSubmenuText(group), {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: buildCustomerSubmenuKeyboard(served.hallName, group),
      }).catch(() => {});
    } else {
      await editMessageTextSafely(bot, HALL_SERVE_LIST_HEADER(served.hallName), {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: buildHallCustomerListKeyboard(served.hallName, hallOrders),
      }).catch(() => {});
    }
  }

  await refreshDeliveryModeMenus(bot);
  await bot.answerCallbackQuery(
    query.id,
    { text: `Order ${served.code} marked ${kind === 'served' ? 'served' : 'dropped off'}.` }
  );
  return true;
}

/**
 * Tell admins a served order's payment still needs reconciling.
 *
 * If the order was already flagged, admins have an existing review card with
 * working Accept/Reject buttons for it - this is a duplicate reminder for
 * that case, harmless since whichever tap lands first wins. For an order
 * that was simply awaiting/verifying payment (never flagged), this is the
 * ONLY way to later mark it paid, so it deliberately reuses the same
 * PAYMENT_ACCEPT_PREFIX callback handlePaymentAccept already handles.
 *
 * No Reject button: rejecting restocks the items, which would be wrong for
 * food that has already been handed over.
 */
async function notifyAdminsServedUnpaid(bot, order) {
  const caption = `🍽️ Order ${order.code} served before payment cleared\n`
    + `👤 ${orderActions.describeCustomer(order)}\n`
    + `🏢 Hall: ${order.hallName}\n`
    + `💰 Amount due: ${formatCents(order.totalCents)}\n\n`
    + `Mark it paid once payment is confirmed.`;

  const keyboard = {
    inline_keyboard: [[
      { text: '✅ Mark Paid', callback_data: `${CALLBACKS.PAYMENT_ACCEPT_PREFIX}${order.id}` },
    ]],
  };

  for (const adminId of getAdminIds()) {
    try {
      await bot.sendMessage(adminId, caption, { reply_markup: keyboard });
    } catch (error) {
      log('warn', 'served_unpaid_notify_failed', {
        order_code: order.code,
        admin_id: adminId,
        error: error.message,
      });
    }
  }
}

/**
 * Add a newly-placed order to a hall's already-sent "Tap each order when
 * served" message, if one is out for that hall. A no-op for halls that
 * haven't had "we are here" posted yet, or whose list is already finished.
 */
async function refreshHallServeOrdersMessage(bot, hallName) {
  const tracked = await getHallServeMessage(hallName);

  if (!tracked) {
    return;
  }

  const hallOrders = await refreshHallServeOrdersCache(hallName);

  if (hallOrders.length === 0) {
    await clearHallServeMessage(hallName);
    return;
  }

  try {
    // Forces back to the top-level list view even if the admin currently has
    // a customer submenu open on this same message - the new order changes
    // what the list looks like, and there is no clean way to patch a
    // submenu's keyboard alone without risking a stale customer's Served/
    // Dropped off buttons pointing at the wrong content.
    await editMessageTextSafely(bot, HALL_SERVE_LIST_HEADER(hallName), {
      chat_id: tracked.chatId,
      message_id: tracked.messageId,
      reply_markup: buildHallCustomerListKeyboard(hallName, hallOrders),
    });
  } catch (error) {
    if (!String(error.message || '').includes('message is not modified')) {
      log('warn', 'hall_serve_message_refresh_failed', { hall: hallName, error: error.message });
    }
  }
}

async function handleFinishDelivery(bot, query, chatId, userId) {
  await bot.answerCallbackQuery(query.id);

  const channelId = config.telegram.dingoChannelId;
  const trackedIds = await consumeTrackedDingoMessageIds();

  if (channelId && trackedIds.length) {
    for (const messageId of trackedIds) {
      try {
        await bot.deleteMessage(channelId, messageId);
      } catch (error) {
        log('warn', 'finish_delete_failed', { error: error.message });
      }
    }
  }

  const menuId = await getMenuMessageId(userId);

  if (menuId) {
    try {
      await bot.deleteMessage(chatId, menuId);
    } catch (error) {
      log('warn', 'finish_menu_delete_failed', { error: error.message });
    }
    await clearMenuMessageId(userId);
  }

  await clearDeliveryModeViewer(userId);

  await bot.sendMessage(chatId, '✅ Delivery finished. Tap below to reset halls when you are ready.', {
    reply_markup: {
      inline_keyboard: [[{ text: '🔄 Reset Halls', callback_data: CALLBACKS.DELIVERY_MODE_RESET_HALLS }]],
    },
  });

  await showMainAdminMenu(bot, chatId, userId);
  return true;
}

module.exports = {
  handleAdminCommand,
  handleAdminCallback,
  refreshPreorderPost,
  refreshHallServeOrdersMessage,
  findNewlySoldOutItems,
  announceSoldOut,
  repostPreorderAvailability,
  refreshPreorderPostAfterStockChange,
  sendPaymentInstructions,
  buildPaymentCaption,
  buildPreorderMessageText,
  resolveImageSource,
  getAdminState,
  setAdminState,
  clearAdminState,

  GET_READY_THRESHOLD,
  meetsAutoPostThreshold,
  notifyHallCustomers,
  kickOpenCartsForHall,
  blockHallForAutoClosure,
  postDingoUpdate,
  autoAdvanceDeliveryStage,

  groupOrdersByCustomer,
  sortCustomerGroups,
  formatCustomerListButtonText,
  encodeCustomerKey,
  decodeCustomerKey,
  buildHallCustomerListKeyboard,
  buildCustomerSubmenuText,
  buildCustomerSubmenuKeyboard,
  loadHallServeOrders,
  refreshHallServeOrdersCache,
  handleServeCustomerOpen,
  handleServeBack,
  handleServeMarkOrder,

  collateRemainingItems,
  buildRemainingItemsText,
  buildRemainingItemsKeyboard,
  handleServeRemainingOpen,
  handleServeDropoffStart,
  handleAdminDropoffPhoto,
};
