const {
  isAdmin, getAdminIds, reloadAdminIds, addAdmin, deleteAdmin,
  getFoodItems, addFoodItem, deleteFoodItem, updateFoodItemStock,
  getHalls, addHall, deleteHall,
  getPreorderAdminTag, getAdminUsernameById, writeToSheet,
} = require('../services/googleSheets');
const { CALLBACKS, STATES, isCallbackType, extractCallbackValue } = require('../config/constants');
const keyboards = require('../utils/keyboards');
const menuTexts = require('../utils/menuTexts');
const { buildComingChannelMessage } = require('../utils/channelMessages');
const { editMessageTextSafely, editMessageCaptionSafely } = require('../utils/telegramEdits');
const orderStore = require('../services/orderStore');
const orderActions = require('../services/orderActions');
const repo = require('../services/orderRepository');
const stateStore = require('../services/stateStore');
const paynowQr = require('../services/paynowQr');
const { getMenuMessageId, setMenuMessageId, clearMenuMessageId } = require('../services/chatTracker');
const { config } = require('../config');
const { formatCents } = require('../utils/money');
const { log } = require('../utils/logger');
const {
  advanceNextHallToPost,
  isExpectedNextHallToPost,
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

function formatOrderServeButtonText(order) {
  return `${order.code} - ${orderActions.describeCustomer(order)} - ${formatCents(order.totalCents)}`;
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

  const halls = await getHalls();
  const blocked = await orderStore.loadBlockedHalls();
  const nextHall = halls.find(hall => !blocked.isBlocked(hall.name));

  if (!nextHall) {
    return { skipped: 'no_unblocked_hall' };
  }

  const adminId = await getPreorderAdminTag();
  const adminUsername = adminId ? await getAdminUsernameById(bot, adminId) : null;
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

    const result = await updateFoodItemStock(state.foodItemId, newStock);
    await bot.sendMessage(chatId, result.message);
    await clearAdminState(userId);

    const foodItems = await getFoodItems();
    await updateMenuMessage(
      bot, chatId, userId,
      menuTexts.manageFoodItemsText(foodItems),
      keyboards.manageFoodItemsKeyboard()
    );

    await refreshPreorderPost(bot);
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

    await refreshPreorderPost(bot);
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

  if (isCallbackType(data, CALLBACKS.DELIVERY_MODE_BLOCK_HALL_PREFIX)) {
    const hallId = Number.parseInt(extractCallbackValue(data, CALLBACKS.DELIVERY_MODE_BLOCK_HALL_PREFIX), 10);
    const hall = (await getHalls()).find(entry => entry.id === hallId);

    if (!hall) {
      await answer('Hall not found', { show_alert: true });
      return true;
    }

    if (!await orderStore.blockHall(hall.name, userId)) {
      await answer(`${hall.name} is already blocked`, { show_alert: true });
      return true;
    }

    await refreshPreorderPost(bot);
    await refreshDeliveryModeMenus(bot);
    await answer(`Blocked ${hall.name}`);
    return true;
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

  if (isCallbackType(data, CALLBACKS.DELIVERY_MODE_SERVE_ORDER_PREFIX)) {
    return handleServeOrder(bot, query, chatId, userId, messageId, data);
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

async function handleDeliveryPost(bot, query, chatId, userId, data) {
  const [postMode, hallIdValue] = extractCallbackValue(data, CALLBACKS.DELIVERY_MODE_POST_CHANNEL_PREFIX).split(':');
  const hallId = Number.parseInt(hallIdValue, 10);

  let holder = null;

  try {
    holder = await stateStore.acquireLock(stateStore.LOCKS.deliveryPost(), { leaseMs: 30000 });

    if (!holder) {
      await bot.answerCallbackQuery(query.id, { text: 'A delivery update is already being posted.' });
      return true;
    }

    const halls = await getHalls();
    const hall = halls.find(entry => entry.id === hallId);

    if (!hall || !['preorder', 'coming', 'here', 'get-ready'].includes(postMode)) {
      await bot.answerCallbackQuery(query.id, { text: 'Hall not found', show_alert: true });
      return true;
    }

    if (!await isExpectedNextHallToPost(halls, hallId, postMode)) {
      await refreshDeliveryModeMenus(bot);
      await bot.answerCallbackQuery(
        query.id,
        { text: 'This button is outdated. Please use the latest delivery menu.', show_alert: true }
      );
      return true;
    }

    const channelId = config.telegram.dingoChannelId;

    if (!channelId) {
      await bot.answerCallbackQuery(query.id, { text: 'DINGO_CHANNEL_ID is not set in the environment.', show_alert: true });
      return true;
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
      await bot.answerCallbackQuery(
        query.id,
        { text: 'Failed to post to the Dingo channel. Check the channel ID and bot permissions.', show_alert: true }
      );
      return true;
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

    if (postMode === 'here') {
      const hallOrders = await orderStore.getActiveOrdersByHall(hall.name);

      if (hallOrders.length > 0) {
        const serveMsg = await bot.sendMessage(
          chatId,
          `✅ ${hallLabel}, we are here\n\nTap each order when served:`,
          { reply_markup: buildHallServeOrdersKeyboard(hallOrders) }
        );
        await recordHallServeMessage(hall.name, chatId, serveMsg.message_id);
      }
    }

    await bot.answerCallbackQuery(
      query.id,
      { text: postMode === 'preorder' ? 'Posted preorder availability to Dingo channel.' : `Posted to Dingo channel: ${text}` }
    );
    return true;
  } finally {
    if (holder) {
      await stateStore.releaseLock(stateStore.LOCKS.deliveryPost(), holder);
    }
  }
}

async function handleServeOrder(bot, query, chatId, userId, messageId, data) {
  const orderId = extractCallbackValue(data, CALLBACKS.DELIVERY_MODE_SERVE_ORDER_PREFIX);

  const served = await orderStore.markOrderServed(orderId, userId);

  if (!served) {
    await bot.answerCallbackQuery(query.id, { text: 'Order is already served or no longer active.' });
    return true;
  }

  try {
    const tagId = await getPreorderAdminTag();
    const tagUsername = tagId ? await getAdminUsernameById(bot, tagId) : null;
    const contact = tagUsername ? `@${tagUsername}` : 'the admin';

    const message = served.wasUnpaid
      ? `✅ Your order ${served.code} has been served.\n\n`
        + `⚠️ Payment for this order is still pending. Please complete it if you haven't, `
        + `or contact ${contact} if you've already paid and this looks like a mistake.`
      : `✅ Your order ${served.code} has been delivered/dropped off!\n\n`
        + `For any issues, please contact ${contact}.`;

    await bot.sendMessage(served.chatId, message);
  } catch (error) {
    log('warn', 'serve_notify_failed', { order_code: served.code, error: error.message });
  }

  if (served.wasUnpaid) {
    await notifyAdminsServedUnpaid(bot, served);
  }

  // Drop just the served order's button, leaving the rest of the list usable.
  const rows = (query.message.reply_markup && query.message.reply_markup.inline_keyboard) || [];
  const servedData = `${CALLBACKS.DELIVERY_MODE_SERVE_ORDER_PREFIX}${orderId}`;
  const remaining = rows
    .map(row => row.filter(button => button.callback_data !== servedData))
    .filter(row => row.length > 0);

  if (remaining.length === 0) {
    await editMessageTextSafely(
      bot,
      `${query.message.text || '✅ Orders for this hall'}\n\n✅ All orders in this list have been served.`,
      { chat_id: chatId, message_id: messageId }
    ).catch(() => {});

    // Only drop the tracked ref if it still points at this message - a later
    // "here" post for the same hall may already have replaced it.
    const tracked = await getHallServeMessage(served.hallName);
    if (tracked && tracked.messageId === messageId) {
      await clearHallServeMessage(served.hallName);
    }
  } else {
    await bot.editMessageReplyMarkup(
      { inline_keyboard: remaining },
      { chat_id: chatId, message_id: messageId }
    ).catch(() => {});
  }

  await refreshDeliveryModeMenus(bot);
  await bot.answerCallbackQuery(query.id, { text: `Order ${served.code} marked as served.` });
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

  const hallOrders = await orderStore.getActiveOrdersByHall(hallName);

  if (hallOrders.length === 0) {
    await clearHallServeMessage(hallName);
    return;
  }

  try {
    await bot.editMessageReplyMarkup(
      buildHallServeOrdersKeyboard(hallOrders),
      { chat_id: tracked.chatId, message_id: tracked.messageId }
    );
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
  sendPaymentInstructions,
  buildPaymentCaption,
  buildPreorderMessageText,
  resolveImageSource,
  getAdminState,
  setAdminState,
  clearAdminState,
};
