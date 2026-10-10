const googleSheets = require('../services/googleSheets');
const {
  isAdmin, getAdminIds, reloadAdminIds, addAdmin, deleteAdmin,
  getHalls, addHall, deleteHall,
  getPreorderAdminTag, getAdminUsernameById, writeToSheet,
} = googleSheets;
const menuStore = require('../services/menuStore');
const { isTemporarilyUnavailable } = require('../utils/unavailable');
const { CALLBACKS, STATES, isCallbackType, extractCallbackValue } = require('../config/constants');
const keyboards = require('../utils/keyboards');
const menuTexts = require('../utils/menuTexts');
const { buildComingChannelMessage } = require('../utils/channelMessages');
const { editMessageTextSafely, editMessageCaptionSafely } = require('../utils/telegramEdits');
const orderStore = require('../services/orderStore');
const orderActions = require('../services/orderActions');
const repo = require('../services/orderRepository');
const stateStore = require('../services/stateStore');
const orderWindow = require('../services/orderWindow');
const { DateTime } = require('luxon');
const { SGT } = require('../utils/time');
const cartStore = require('../services/cartStore');
const statsService = require('../services/statsService');
const { collectStatus, formatStatus } = require('../services/statusReport');
const paynowQr = require('../services/paynowQr');
const {
  getMenuMessageId, setMenuMessageId, clearMenuMessageId, isMessageLatestInChat, noteChatMessage,
} = require('../services/chatTracker');
const { config } = require('../config');
const { formatCents, parsePriceInput } = require('../utils/money');
const { isImageDocument } = require('../utils/telegramFiles');
const { log } = require('../utils/logger');
const {
  DEFAULT_SEQUENCER,
  setSequencer,
  advanceNextHallToPost,
  isExpectedNextHallToPost,
  getNextHallToPostState,
  getGatingHall,
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
  refreshDeliveryModeMenus: refreshDeliveryModeMenusOnly,
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

// --- Custom preorder post (Settings > Edit Dingo Post) ------------------------

// Telegram caps photo captions at 1024 characters. The custom line is kept
// well under that so the food list and contact line still fit beneath it.
const PHOTO_CAPTION_MAX_LENGTH = 1024;
const PREORDER_CUSTOM_TEXT_MAX_LENGTH = 500;

async function getPreorderCustom() {
  const stored = await stateStore.get(stateStore.KEYS.preorderCustom(), null) || {};
  return { text: stored.text || null, photoFileId: stored.photoFileId || null };
}

async function setPreorderCustom(patch) {
  return stateStore.update(stateStore.KEYS.preorderCustom(), current => ({ ...(current || {}), ...patch }));
}

/**
 * The first line of the preorder post: the admin's custom text from Settings
 * ("Edit Dingo Post"), or the default when none is set. {hall} in custom
 * text is replaced with the hall ordering opens from.
 */
function buildPreorderIntro(hallLabel, customText) {
  if (!customText) {
    return '🍱 Hall delivery orders are now open!';
  }

  return escapeHtml(customText).replace(/\{hall\}/gi, () => escapeHtml(hallLabel));
}

async function buildPreorderMessageText(hallLabel, adminUsername, { customText = null, maxLength = Infinity, cutoffLabel = null } = {}) {
  // Throws rather than rendering "No food currently available" onto the public
  // post whenever a Sheets read blips.
  const foodItems = await menuStore.getFoodItemsOrThrow();
  const contactLine = adminUsername
    ? `Or for any delivery related issues, message @${adminUsername}.`
    : 'Or for any delivery related issues, please contact an admin.';

  const intro = buildPreorderIntro(hallLabel, customText);
  const foodLines = buildAvailableFoodLines(foodItems);
  const cutoffLine = cutoffLabel
    ? `⏰ Order before ${cutoffLabel} - ordering closes sharply then so the drivers can focus on delivering.\n\n`
    : '';
  const render = lines => `${intro}\n\n${cutoffLine}`
    + `Available food:\n${lines.join('\n')}\n\n`
    + `Click below to start ordering.\n${contactLine}`;

  // A photo caption is capped at 1024 characters: drop food lines from the
  // end (saying how many) rather than have Telegram reject the whole post.
  let text = render(foodLines);
  for (let shown = foodLines.length - 1; text.length > maxLength && shown >= 1; shown -= 1) {
    text = render([...foodLines.slice(0, shown), `• …and ${foodLines.length - shown} more`]);
  }

  return text;
}

async function buildStageTwoMessageText(adminUsername) {
  const foodItems = await menuStore.getFoodItemsOrThrow();
  const available = foodItems.filter(item => Number(item.stock) > 0);
  const lines = available.length
    ? available.map(item => `• ${escapeHtml(item.name)} (${item.stock} left)`)
    : ['• Nothing left right now'];
  const contactLine = adminUsername
    ? `For any delivery related issues, message @${adminUsername}.`
    : 'For any delivery related issues, please contact an admin.';

  return '🚚 We are on our way - and we have a few spares!\n\n'
    + `Still available:\n${lines.join('\n')}\n\n`
    + 'Tap below to order. This is only for halls we have not reached yet - '
    + `once we pass your hall, ordering for it closes.\n${contactLine}`;
}

/**
 * Everything the live preorder post shows, rendered once so posting, editing
 * and reposting can't drift apart. photoFileId is set when an admin attached
 * a photo in Settings - the post is then that photo with the text as caption.
 */
async function renderPreorderContent(bot, hallLabel, options = {}) {
  const window = await orderWindow.getWindow();
  const stage = options.stage || (window && window.stage) || null;

  // Ordering is closed: same post, now saying so, with no button. A photo on
  // the post stays (an edit can't remove it).
  if (stage === orderWindow.STAGES.CLOSED) {
    const post = await getPreorderPost();
    const closedPhoto = post.photoFileId || null;
    return {
      text: STAGE1_CLOSED_POST_TEXT,
      photoFileId: closedPhoto,
      button: null,
      contentHash: `closed::${closedPhoto || ''}`,
    };
  }

  const adminId = await googleSheets.getPreorderAdminTag();
  const adminUsername = adminId ? await googleSheets.getAdminUsernameById(bot, adminId) : null;
  const startUrl = await getBotStartUrl(bot);

  // Spare stock: fixed wording, live remaining stock, never the stage-1 photo.
  if (stage === orderWindow.STAGES.STAGE2) {
    const text = await buildStageTwoMessageText(adminUsername);
    return {
      text,
      photoFileId: null,
      button: buildPreorderStartButton(startUrl),
      contentHash: `${text}::${startUrl}::`,
    };
  }

  const custom = await getPreorderCustom();
  const photoFileId = custom.photoFileId || null;
  const cutoffAtIso = options.cutoffAt || (window && window.cutoffAt) || null;
  const cutoffLabel = cutoffAtIso
    ? orderWindow.formatClock(DateTime.fromISO(cutoffAtIso).setZone(SGT).toFormat('HH:mm'))
    : null;

  const text = await buildPreorderMessageText(hallLabel, adminUsername, {
    customText: custom.text,
    maxLength: photoFileId ? PHOTO_CAPTION_MAX_LENGTH : Infinity,
    cutoffLabel,
  });

  return {
    text,
    photoFileId,
    button: buildPreorderStartButton(startUrl),
    contentHash: `${text}::${startUrl}::${photoFileId || ''}`,
  };
}

async function sendPreorderContent(bot, chatId, content) {
  const markup = content.button ? { reply_markup: content.button } : {};

  if (content.photoFileId) {
    return bot.sendPhoto(chatId, content.photoFileId, { caption: content.text, parse_mode: 'HTML', ...markup });
  }

  return bot.sendMessage(chatId, content.text, { parse_mode: 'HTML', disable_web_page_preview: true, ...markup });
}

/**
 * Replace the live preorder post with a freshly sent one. Needed whenever the
 * post switches between text and photo (or to a different photo), which an
 * edit can't do. The old post is only deleted once the new one is out.
 */
async function replacePreorderPost(bot, post, content) {
  let sent;
  try {
    sent = await sendPreorderContent(bot, post.channelId, content);
  } catch (error) {
    log('error', 'preorder_repost_failed', { error: error.message });
    return false;
  }

  try {
    await bot.deleteMessage(post.channelId, post.msgId);
  } catch (error) {
    log('warn', 'preorder_repost_delete_failed', { error: error.message });
  }

  await recordPreorderPost(post.channelId, sent.message_id, content.photoFileId);
  return true;
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
  try {
    return await renderPreorderPost(bot);
  } catch (error) {
    if (!isTemporarilyUnavailable(error)) {
      throw error;
    }
    // Leave the live post as it is; the next scheduled refresh retries.
    log('warn', 'preorder_refresh_sheets_unavailable', { error: error.message });
    return { skipped: 'sheets_unavailable' };
  }
}

async function renderPreorderPost(bot) {
  const post = await getPreorderPost();

  if (!post.channelId || !post.msgId) {
    return { skipped: 'no_post' };
  }

  const halls = await googleSheets.getHallsOrThrow();
  const blocked = await orderStore.loadBlockedHalls();
  const nextHall = halls.find(hall => !blocked.isBlocked(hall.name));

  if (!nextHall) {
    return { skipped: 'no_unblocked_hall' };
  }

  const content = await renderPreorderContent(bot, nextHall.shortName || nextHall.name);
  const { contentHash } = content;

  if (post.contentHash === contentHash) {
    return { skipped: 'unchanged' };
  }

  // An edit can't turn a text post into a photo (or swap the photo).
  if ((post.photoFileId || null) !== content.photoFileId) {
    return (await replacePreorderPost(bot, post, content)) ? { reposted: true } : { failed: true };
  }

  try {
    // No button (ordering closed) must clear the old one - an edit that omits
    // reply_markup can leave the previous keyboard in place.
    const markup = { reply_markup: content.button || { inline_keyboard: [] } };

    if (content.photoFileId) {
      await bot.editMessageCaption(content.text, {
        chat_id: post.channelId,
        message_id: post.msgId,
        parse_mode: 'HTML',
        ...markup,
      });
    } else {
      await bot.editMessageText(content.text, {
        chat_id: post.channelId,
        message_id: post.msgId,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        ...markup,
      });
    }

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
  await statsService.recordSoldOut(soldOutItems);

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

  // A closed post has nothing to announce; re-sending it would just be noise.
  const window = await orderWindow.getWindow();
  if (window && window.stage === orderWindow.STAGES.CLOSED) {
    return;
  }

  let content;
  try {
    const halls = await googleSheets.getHallsOrThrow();
    const blocked = await orderStore.loadBlockedHalls();
    const nextHall = halls.find(hall => !blocked.isBlocked(hall.name));

    if (!nextHall) {
      return;
    }

    content = await renderPreorderContent(bot, nextHall.shortName || nextHall.name);
  } catch (error) {
    if (!isTemporarilyUnavailable(error)) {
      throw error;
    }
    // Keep the existing post rather than replace it with an empty menu; the
    // scheduled refresh brings it up to date once Sheets answers again.
    log('warn', 'preorder_repost_sheets_unavailable', { error: error.message });
    return;
  }

  await replacePreorderPost(bot, post, content);
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

/**
 * Settings > Edit Dingo Post, optionally with a line saying what just
 * happened to the live post.
 */
async function showPreorderPostMenu(bot, chatId, userId, status = null) {
  const custom = await getPreorderCustom();
  const text = menuTexts.preorderPostText(custom) + (status ? `\n\n${status}` : '');
  await updateMenuMessage(bot, chatId, userId, text, keyboards.preorderPostKeyboard(custom));
}

/** Push a saved change to the live preorder post, and describe the result. */
async function applyPreorderCustomChange(bot) {
  const result = await refreshPreorderPost(bot);

  if (result.refreshed || result.reposted || result.skipped === 'unchanged' || result.skipped === 'not_modified') {
    return '✅ Saved - the live preorder post has been updated.';
  }

  if (result.skipped === 'no_post' || result.skipped === 'no_unblocked_hall') {
    return '✅ Saved - it will be used for the next preorder post.';
  }

  return "✅ Saved, but the live post couldn't be updated just now - it will retry within a minute.";
}

async function handlePreorderPostCallback(bot, query, chatId, userId, data, answer) {
  if (data === CALLBACKS.SETTINGS_PREORDER_POST) {
    await clearAdminState(userId);
    await showPreorderPostMenu(bot, chatId, userId);
    await answer();
    return true;
  }

  if (data === CALLBACKS.PREORDER_EDIT_TEXT) {
    await setAdminState(userId, STATES.EDIT_PREORDER_TEXT);
    await updateMenuMessage(
      bot, chatId, userId,
      menuTexts.preorderEditTextPromptText(PREORDER_CUSTOM_TEXT_MAX_LENGTH),
      keyboards.backToPreorderPostKeyboard()
    );
    await answer();
    return true;
  }

  if (data === CALLBACKS.PREORDER_ATTACH_PHOTO) {
    await setAdminState(userId, STATES.ATTACH_PREORDER_PHOTO);
    await updateMenuMessage(
      bot, chatId, userId,
      menuTexts.preorderAttachPhotoPromptText(),
      keyboards.backToPreorderPostKeyboard()
    );
    await answer();
    return true;
  }

  if (data === CALLBACKS.PREORDER_RESET_TEXT || data === CALLBACKS.PREORDER_REMOVE_PHOTO) {
    await answer();
    await setPreorderCustom(data === CALLBACKS.PREORDER_RESET_TEXT ? { text: null } : { photoFileId: null });
    await showPreorderPostMenu(bot, chatId, userId, await applyPreorderCustomChange(bot));
    return true;
  }

  if (data === CALLBACKS.PREORDER_PREVIEW) {
    return handlePreorderPreview(bot, chatId, answer);
  }

  return false;
}

/**
 * Send the admin exactly what the channel would get right now - same
 * renderer, same photo/caption handling - without touching the channel.
 */
async function handlePreorderPreview(bot, chatId, answer) {
  let content;
  try {
    const halls = await googleSheets.getHallsOrThrow();
    const blocked = await orderStore.loadBlockedHalls();
    const hall = halls.find(entry => !blocked.isBlocked(entry.name)) || halls[0];
    content = await renderPreorderContent(bot, hall ? (hall.shortName || hall.name) : 'your hall');
  } catch (error) {
    if (!isTemporarilyUnavailable(error)) {
      throw error;
    }
    await answer('Could not read the menu. Try again in a moment.', { show_alert: true });
    return true;
  }

  try {
    await sendPreorderContent(bot, chatId, content);
    await answer('Preview sent below.');
  } catch (error) {
    log('warn', 'preorder_preview_failed', { error: error.message });
    await answer(`Telegram rejected the preview: ${error.message}`, { show_alert: true });
  }

  return true;
}

/**
 * The admin's photo for the preorder post, sent after tapping Attach Photo.
 * Returns false (not handled) unless that prompt is pending, so every other
 * photo falls through to drop-off/receipt handling as before.
 */
async function handleAdminPreorderPhoto(bot, msg) {
  const userId = msg.from.id;

  if (!isAdmin(userId) || await getAdminState(userId) !== STATES.ATTACH_PREORDER_PHOTO) {
    return false;
  }

  const chatId = msg.chat.id;

  // Only a photo's file_id can be re-sent as a photo; a file's can't.
  if (!msg.photo || !msg.photo.length) {
    await bot.sendMessage(chatId, '❌ Please send it as a photo, not as a file.');
    return true;
  }

  await setPreorderCustom({ photoFileId: msg.photo[msg.photo.length - 1].file_id });
  await clearAdminState(userId);

  try {
    await bot.deleteMessage(chatId, msg.message_id);
  } catch (error) {
    log('warn', 'preorder_photo_input_delete_failed', { error: error.message });
  }

  await showPreorderPostMenu(bot, chatId, userId, await applyPreorderCustomChange(bot));
  return true;
}

async function showMainAdminMenu(bot, chatId, userId) {
  await reloadAdminIds();
  await updateMenuMessage(bot, chatId, userId, menuTexts.mainMenuText(), keyboards.mainMenuKeyboard());
}

/**
 * /adminmenu: the menu appears at the bottom of the chat, where the admin is
 * looking, instead of editing an old copy further up. If the existing menu is
 * already the latest message it is simply refreshed in place; otherwise it is
 * deleted and sent again.
 */
async function sendMainAdminMenuAtBottom(bot, chatId, userId) {
  await reloadAdminIds();

  const existingId = await getMenuMessageId(userId);

  if (existingId && await isMessageLatestInChat(chatId, existingId)) {
    await updateMenuMessage(bot, chatId, userId, menuTexts.mainMenuText(), keyboards.mainMenuKeyboard());
    return;
  }

  if (existingId) {
    try {
      await bot.deleteMessage(chatId, existingId);
    } catch (error) {
      log('warn', 'admin_menu_delete_failed', { error: error.message });
    }
    await clearMenuMessageId(userId);
  }

  const sent = await bot.sendMessage(chatId, menuTexts.mainMenuText(), { reply_markup: keyboards.mainMenuKeyboard() });
  await setMenuMessageId(userId, sent.message_id);
  await noteChatMessage(chatId, sent.message_id);
  await clearDeliveryModeViewer(userId);
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

  if (state && await handleAdminStateInput(bot, chatId, userId, text, state, msg.message_id)) {
    return true;
  }

  if (text === '/adminmenu') {
    await sendMainAdminMenuAtBottom(bot, chatId, userId);
    return true;
  }

  if (text === '/skip') {
    return handleSkipCommand(bot, chatId, userId);
  }

  if (text === '/status') {
    return handleStatusCommand(bot, msg);
  }

  return false;
}

/**
 * Health of every outside service the bot depends on, in one message.
 *
 * Private chats only: the report carries error text and deploy details that do
 * not belong in a group customers may be able to read.
 */
async function handleStatusCommand(bot, msg) {
  const chatId = msg.chat.id;

  if (msg.chat.type !== 'private') {
    await bot.sendMessage(chatId, 'Send /status to me in a private chat.');
    return true;
  }

  // The checks can take a few seconds when something is slow.
  await bot.sendChatAction(chatId, 'typing').catch(() => {});

  const results = await collectStatus(bot);
  await bot.sendMessage(chatId, formatStatus(results));
  return true;
}

/**
 * Manual override: force-post whatever the sequencer currently has queued
 * as next (get-ready, coming, or here), regardless of serve progress. The
 * automatic get-ready/coming triggers have no manual button of their own
 * (see MAINTENANCE.md limitation #16 and README's "Delivery mode" section) -
 * this is the recovery path for when that automation can't or shouldn't
 * wait, or silently didn't fire (auto_advance_post_failed in the logs).
 *
 * Goes through postDingoUpdate, the exact same path a button tap or the
 * automation itself uses, so it is still lock-safe against a concurrent
 * post and still runs the same customer-notify/hall-block hooks.
 */
async function handleSkipCommand(bot, chatId, userId) {
  const halls = await googleSheets.getHalls();
  const { hall: nextHall, mode } = await getNextHallToPostState(halls);

  if (!nextHall) {
    await bot.sendMessage(chatId, 'Nothing queued to skip to right now.');
    return true;
  }

  // Spare stock always goes through the confirm-stock screen.
  if (mode === 'preorder') {
    return showStageTwoPanel(bot, chatId, userId, nextHall.id, async text => {
      if (text) {
        await bot.sendMessage(chatId, text);
      }
    });
  }

  const result = await postDingoUpdate(bot, { hallId: nextHall.id, postMode: mode, notifyChatId: chatId });

  if (!result.posted) {
    const FAILURE_MESSAGES = {
      locked: 'A delivery update is already being posted - try again in a moment.',
      hall_not_found: 'Hall not found - the halls list may have changed since this was queued.',
      stale: 'This has already moved on. Reopen Delivery Mode to see the current state.',
      no_channel: 'DINGO_CHANNEL_ID is not set in the environment.',
      send_failed: 'Failed to post to the Dingo channel. Check the channel ID and bot permissions.',
      sheets_unavailable: 'Could not read the menu. Nothing was posted - try again in a moment.',
    };

    await bot.sendMessage(chatId, `❌ ${FAILURE_MESSAGES[result.reason] || 'Could not post.'}`);
    return true;
  }

  await bot.sendMessage(chatId, `⏭️ Skipped ahead - posted to the Dingo channel: ${result.text}`);

  // Mirrors handleDeliveryPost: a skipped "here" for a hall nobody ordered
  // from should still cascade straight through its own get-ready/coming.
  if (mode === 'here') {
    await autoAdvanceDeliveryStage(bot, result.hall.name);
  }

  return true;
}

/** Multi-step prompts: add admin, add food, add hall, edit stock. */
async function handleAdminStateInput(bot, chatId, userId, text, state, messageId) {
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

      const result = await menuStore.addFoodItem(parts[0], price);
      await bot.sendMessage(chatId, result.message);
      await clearAdminState(userId);

      const foodItems = await menuStore.getFoodItems();
      await updateMenuMessage(
        bot, chatId, userId,
        menuTexts.manageFoodItemsText(foodItems),
        keyboards.manageFoodItemsKeyboard()
      );
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

    if (state === STATES.EDIT_PREORDER_TEXT) {
      const customText = String(text || '').trim();

      if (!customText) {
        await bot.sendMessage(chatId, '❌ Please send the text as a message (or tap Back).');
        return true;
      }

      if (customText.length > PREORDER_CUSTOM_TEXT_MAX_LENGTH) {
        await bot.sendMessage(
          chatId,
          `❌ That's ${customText.length} characters - please keep it to ${PREORDER_CUSTOM_TEXT_MAX_LENGTH} or fewer.`
        );
        return true;
      }

      await setPreorderCustom({ text: customText });
      await clearAdminState(userId);

      // Same tidy-up as the stock prompts: the self-editing menu now shows
      // the saved text, so the typed message itself isn't needed.
      try {
        await bot.deleteMessage(chatId, messageId);
      } catch (error) {
        log('warn', 'preorder_text_input_delete_failed', { error: error.message });
      }

      await showPreorderPostMenu(bot, chatId, userId, await applyPreorderCustomChange(bot));
      return true;
    }

    if (state === STATES.EDIT_POST_TIME || state === STATES.EDIT_CUTOFF_TIME) {
      return handleScheduleInput(bot, chatId, userId, text, state, messageId);
    }

    if (state === STATES.ATTACH_PREORDER_PHOTO) {
      await bot.sendMessage(chatId, '🖼 Please send a photo for the preorder post (or tap Back).');
      return true;
    }

    return false;
  }

  if (state.mode === STATES.EDIT_STAGE2_STOCK) {
    return handleStageTwoStockInput(bot, chatId, userId, text, state, messageId);
  }

  if (state.mode === STATES.EDIT_FOOD_PRICE) {
    const price = parsePriceInput(text);

    if (price === null) {
      // Stays in the prompt so the admin can simply type it again.
      await bot.sendMessage(
        chatId,
        '❌ Invalid price. Send a number above 0 with at most 2 decimals, e.g. 5.99'
      );
      return true;
    }

    const result = await menuStore.updateFoodItemPrice(state.foodItemId, price);
    const confirmation = await bot.sendMessage(chatId, result.message);
    await clearAdminState(userId);

    // The number typed in and its confirmation are only useful for the instant
    // it takes to apply - clean them up so the self-editing menu (which now
    // shows the new price) is the only thing left, as the stock prompts do.
    try {
      await bot.deleteMessage(chatId, messageId);
    } catch (error) {
      log('warn', 'price_edit_input_delete_failed', { error: error.message });
    }
    try {
      await bot.deleteMessage(chatId, confirmation.message_id);
    } catch (error) {
      log('warn', 'price_edit_confirmation_delete_failed', { error: error.message });
    }

    const foodItems = await menuStore.getFoodItems();
    await updateMenuMessage(
      bot, chatId, userId,
      menuTexts.manageFoodItemsText(foodItems),
      keyboards.manageFoodItemsKeyboard()
    );

    // No preorder-post refresh: the public post lists only the names of items in
    // stock, never prices, so a price change cannot change what it shows.
    return true;
  }

  if (state.mode === STATES.EDIT_FOOD_STOCK_SPECIFIC) {
    const newStock = Number.parseInt(text, 10);

    if (Number.isNaN(newStock) || newStock < 0) {
      await bot.sendMessage(chatId, '❌ Invalid stock level. Please enter a non-negative number.');
      return true;
    }

    const beforeItem = (await menuStore.getFoodItems()).find(item => item.id === state.foodItemId);

    const result = await menuStore.updateFoodItemStock(state.foodItemId, newStock);
    const confirmation = await bot.sendMessage(chatId, result.message);
    await clearAdminState(userId);

    // The number typed in and its confirmation are only useful for the
    // instant it takes to apply - clean them up so the self-editing menu
    // (which now shows the new stock level anyway) is the only thing left.
    try {
      await bot.deleteMessage(chatId, messageId);
    } catch (error) {
      log('warn', 'stock_edit_input_delete_failed', { error: error.message });
    }
    try {
      await bot.deleteMessage(chatId, confirmation.message_id);
    } catch (error) {
      log('warn', 'stock_edit_confirmation_delete_failed', { error: error.message });
    }

    const foodItems = await menuStore.getFoodItems();
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
    const saved = await menuStore.updateFoodItemStock(currentItem.id, newStock);

    // Stay on this item so the admin can retry, rather than silently moving on.
    if (!saved.success) {
      await bot.sendMessage(chatId, `${saved.message}\n\nPlease send the stock for ${currentItem.name} again.`);
      return true;
    }

    // Keeps the loop clean - only the self-editing prompt should remain
    // between steps, not a trail of the numbers typed along the way.
    try {
      await bot.deleteMessage(chatId, messageId);
    } catch (error) {
      log('warn', 'stock_edit_input_delete_failed', { error: error.message });
    }

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

    const completion = await bot.sendMessage(chatId, menuTexts.updateCompleteText(state.items.length));
    await clearAdminState(userId);

    try {
      await bot.deleteMessage(chatId, completion.message_id);
    } catch (error) {
      log('warn', 'stock_edit_completion_delete_failed', { error: error.message });
    }

    const updatedItems = await menuStore.getFoodItems();
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
// Swapped out by sendPaymentInstructions when no QR image could be sent at all.
const PAY_WITH_QR_LINE = '1️⃣ Pay with the PayNow QR above';
const NO_QR_LINE = '1️⃣ QR unavailable - please contact an admin for payment details';

function buildPaymentCaption(order) {
  const heading = `✅ Order ${order.code} placed (${order.hallName})\n`;
  // The total sits with the instructions rather than in the item summary, so
  // trimming a long item list below can never cut it off.
  const instructions = `\n💰 Total: ${formatCents(order.totalCents)}\n\n${PAY_WITH_QR_LINE}\n`
    + '2️⃣ Send an UNCROPPED screenshot showing date, time, amount and recipient (swipe for example)\n\n'
    + (config.payment.expiryEnabled ? `⚠️ Pay within ${config.payment.windowMinutes} min.` : 'Send your screenshot after paying.');
  const summary = order.items
    .map(item => `• ${item.name} x${item.quantity} = ${formatCents(item.lineTotalCents)}`)
    .join('\n') || 'No items';
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

  await orderActions.notify(bot, order.chatId, caption.replace(PAY_WITH_QR_LINE, NO_QR_LINE));
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
      customerMessage: `❌ Order ${order.code} was rejected (too late or an issue with it). /start to reorder.`,
    });

    if (!result.success) {
      await bot.answerCallbackQuery(query.id, { text: result.message || 'Failed to reject order', show_alert: true });
      return true;
    }

    await editMessageTextSafely(
      bot,
      `${query.message.text}\n\n❌ Status: Rejected by admin ${userId}\n${restockNote(result)}`,
      { chat_id: chatId, message_id: messageId }
    ).catch(() => {});

    await refreshDeliveryModeMenus(bot);
    await refreshPreorderPost(bot);

    await bot.answerCallbackQuery(query.id, { text: `Order rejected${result.restocked ? ' and stock restored' : ''}` });
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
    await bringDeliveryMenuToBottom(bot, chatId, userId);
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
      customerMessage: `❌ Payment for Order ${order.code} rejected. /start to reorder.`,
    });

    if (!result.success) {
      await bot.answerCallbackQuery(query.id, { text: result.message || 'Failed to reject payment', show_alert: true });
      return true;
    }

    await recordManualReview(orderId, userId, 'manually_rejected');
    await updateReviewMessage(
      bot, query, chatId, messageId,
      `\n\n❌ Payment rejected by admin ${userId}\n${restockNote(result)}`
    );
    await refreshDeliveryModeMenus(bot);
    // The order was in the active set (payment_flagged/awaiting/verifying),
    // so it may be sitting in a hall's cached "we are here" list - drop it
    // now rather than waiting for the next unrelated order at that hall.
    await refreshHallServeOrdersMessage(bot, order.hallName);

    await bot.answerCallbackQuery(query.id, { text: `Payment rejected${result.restocked ? ' and stock restored' : ''}` });
    await bringDeliveryMenuToBottom(bot, chatId, userId);
    return true;
  });
}

/**
 * After an admin accepts or rejects a payment, move their delivery menu back to
 * the bottom of their chat: the review card they just tapped sits below the
 * menu, so the menu would otherwise be left stranded above it.
 *
 * Only for the admin who acted, and only if they have the delivery menu open.
 * Background refreshes (other admins' taps, automatic approvals) keep editing
 * in place on purpose - reposting on every one spammed notifications.
 * Never throws: the payment decision has already been made.
 */
async function bringDeliveryMenuToBottom(bot, chatId, userId) {
  try {
    const viewing = await stateStore.get(stateStore.KEYS.deliveryViewer(userId));

    if (!viewing) {
      return;
    }

    await showDeliveryModeMenu(bot, chatId, userId);
    await repositionHallServeMessagesBelowMenu(bot, chatId);
  } catch (error) {
    log('warn', 'delivery_menu_bring_down_failed', { error: error.message });
  }
}

/** Status line for a rejection's review message - see orderActions.alertRestockFailed. */
function restockNote(result) {
  return result.restocked ? '↩️ Stock restored' : '⚠️ Stock NOT restored - add it back by hand (details sent separately)';
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
    // One Supabase query; a failure must not take the basic stats down with it.
    let funStats = '';
    try {
      const { stats, capped } = await statsService.fetchStats();
      funStats = statsService.formatFunStats(stats, capped);
    } catch (error) {
      log('warn', 'fun_stats_failed', { error: error.message });
    }

    await updateMenuMessage(
      bot, chatId, userId,
      menuTexts.adminStatsText(getAdminIds().length) + funStats,
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
    const foodItems = await menuStore.getFoodItems();
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
    const foodItems = await menuStore.getFoodItems();

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
    const liveItem = (await menuStore.getFoodItems()).find(item => item.id === foodItemId);

    if (!liveItem || createCallbackItemToken(liveItem.name) !== token) {
      await answer('This delete button is outdated. Reopen Delete Food list.', { show_alert: true });
      return true;
    }

    const result = await menuStore.deleteFoodItem(foodItemId);
    await updateMenuMessage(bot, chatId, userId, result.message, keyboards.backToFoodMenuKeyboard());
    await answer();
    await refreshPreorderPost(bot);
    return true;
  }

  if (data === CALLBACKS.FOOD_EDIT_STOCK) {
    const foodItems = await menuStore.getFoodItems();

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
    const foodItems = await menuStore.getFoodItems();

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

  if (data === CALLBACKS.FOOD_EDIT_PRICE) {
    const foodItems = await menuStore.getFoodItems();

    if (foodItems.length === 0) {
      await updateMenuMessage(bot, chatId, userId, menuTexts.noFoodItemsText(), keyboards.backToFoodMenuKeyboard());
      await answer();
      return true;
    }

    await updateMenuMessage(
      bot, chatId, userId,
      menuTexts.editPriceListText(),
      keyboards.foodItemsEditPriceKeyboard(foodItems)
    );
    await answer();
    return true;
  }

  if (isCallbackType(data, CALLBACKS.FOOD_EDIT_PRICE_PREFIX)) {
    const foodItemId = Number.parseInt(extractCallbackValue(data, CALLBACKS.FOOD_EDIT_PRICE_PREFIX), 10);
    const item = (await menuStore.getFoodItems()).find(entry => entry.id === foodItemId);

    // The list was drawn a while ago: the item may have been deleted since.
    if (!item) {
      await answer('That item no longer exists. Reopen Edit Price.', { show_alert: true });
      return true;
    }

    await setAdminState(userId, { mode: STATES.EDIT_FOOD_PRICE, foodItemId });

    await updateMenuMessage(
      bot, chatId, userId,
      menuTexts.editPricePromptText(item.name, item.price),
      keyboards.cancelStockEditKeyboard()
    );
    await answer();
    return true;
  }

  if (await handleStageCallbacks(bot, query, chatId, userId, data, answer)) {
    return true;
  }

  if (await handlePreorderPostCallback(bot, query, chatId, userId, data, answer)) {
    return true;
  }

  if (data === CALLBACKS.SETTINGS_MANAGE_HALLS) {
    await updateMenuMessage(
      bot, chatId, userId,
      menuTexts.manageHallsText(await getHalls({ fresh: true })),
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
    const halls = await getHalls({ fresh: true });

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

    // Fresh: deleteHall shifts rows by id, so the check must be against the
    // sheet as it is now, not a cached copy.
    const liveHall = (await getHalls({ fresh: true })).find(hall => hall.id === hallId);

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
    await repositionHallServeMessagesBelowMenu(bot, chatId);
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

  if (isCallbackType(data, CALLBACKS.DELIVERY_MODE_SERVE_LIST_PREFIX)) {
    return handleServeListResend(bot, chatId, extractCallbackValue(data, CALLBACKS.DELIVERY_MODE_SERVE_LIST_PREFIX), answer);
  }

  // Reset buttons from before the reset became automatic: tell the admin
  // instead of letting the tap spin.
  if (data === CALLBACKS.DELIVERY_MODE_RESET_FIRST
    || [CALLBACKS.DELIVERY_MODE_RESET_HALLS, CALLBACKS.DELIVERY_MODE_RESET_CONFIRM_PREFIX, CALLBACKS.DELIVERY_MODE_RESET_CANCEL_PREFIX]
      .some(prefix => isCallbackType(data, prefix))) {
    await answer('Halls and orders now reset automatically when the preorder is posted.', { show_alert: true });
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
 * TEMPORARY: per-step timing for the slow "we are here" tap. Logs one
 * `timing` line with each step's duration in ms. Remove once the slow step is
 * found and fixed.
 */
function createStepTimer(label, meta = {}) {
  const start = Date.now();
  const steps = {};
  let logged = false;

  return {
    async step(name, fn) {
      const stepStart = Date.now();
      try {
        return await fn();
      } finally {
        steps[name] = Date.now() - stepStart;
      }
    },
    done() {
      if (logged) {
        return;
      }
      logged = true;
      log('info', 'timing', { label, total_ms: Date.now() - start, steps, ...meta });
    },
  };
}

/**
 * Core channel-post + sequencer-advance logic, shared by the manual admin tap
 * (preorder/here) and the automatic get-ready/coming triggers fired by serve
 * progress. Never throws for an expected failure (stale button, missing
 * channel, a Telegram send error) - callers decide how to surface that.
 */
async function postDingoUpdate(bot, { hallId, postMode, notifyChatId = null, onPosted = null, refreshMenus = true }) {
  let holder = null;
  const timer = createStepTimer('dingo_post', { mode: postMode });

  try {
    holder = await timer.step('lock', () => stateStore.acquireLock(stateStore.LOCKS.deliveryPost(), { leaseMs: 30000 }));

    if (!holder) {
      return { posted: false, reason: 'locked' };
    }

    // The preorder post starts a round, so it re-reads halls from the sheet;
    // every other stage uses the cache (see googleSheets.getHallsOrThrow).
    const halls = await timer.step('getHalls', () => googleSheets.getHalls({ fresh: postMode === 'preorder' }));
    const hall = halls.find(entry => entry.id === hallId);

    if (!hall || !['preorder', 'coming', 'here', 'get-ready'].includes(postMode)) {
      return { posted: false, reason: 'hall_not_found' };
    }

    if (!await timer.step('expectedCheck', () => isExpectedNextHallToPost(halls, hallId, postMode))) {
      await refreshDeliveryModeMenus(bot);
      return { posted: false, reason: 'stale' };
    }

    const channelId = config.telegram.dingoChannelId;

    if (!channelId) {
      return { posted: false, reason: 'no_channel' };
    }


    const hallLabel = hall.shortName || hall.name;

    // The preorder post is the one with a menu, an ordering button and
    // possibly an admin-attached photo; the other stages are plain one-liners.
    // The 'preorder' step is stage 2 now (spare stock); stage 1 is posted by
    // postStageOne. The stage-1 / "ordering closed" post it replaces is deleted
    // once the new post is out.
    const preorderContent = postMode === 'preorder'
      ? await renderPreorderContent(bot, hallLabel, { stage: orderWindow.STAGES.STAGE2 })
      : null;
    const previousPreorderPost = postMode === 'preorder' ? await getPreorderPost() : null;

    let text;
    if (preorderContent) {
      text = preorderContent.text;
    } else if (postMode === 'get-ready') {
      text = `Get ready, ${hallLabel}`;
    } else if (postMode === 'here') {
      text = `${hallLabel}, we are here`;
    } else {
      text = buildComingChannelMessage(hallLabel);
    }

    let sent;
    try {
      sent = await timer.step('sendChannel', () => (preorderContent
        ? sendPreorderContent(bot, channelId, preorderContent)
        : bot.sendMessage(channelId, text, {})));
    } catch (error) {
      log('error', 'dingo_post_failed', { hall: hallLabel, error: error.message });
      return { posted: false, reason: 'send_failed' };
    }

    // The channel post is out, so the admin's button can stop spinning now
    // rather than after all the bookkeeping below.
    if (onPosted) {
      await timer.step('onPosted', async () => {
        try {
          await onPosted({ text, hall, hallLabel });
        } catch (error) {
          log('warn', 'dingo_on_posted_failed', { error: error.message });
        }
      });
    }

    const toDelete = await timer.step('msgIds', () => getDingoMsgIdsToDelete(postMode));

    if (previousPreorderPost && previousPreorderPost.msgId) {
      toDelete.push(previousPreorderPost.msgId);
    }

    await timer.step('recordPost', async () => {
      if (preorderContent) {
        await recordPreorderPost(channelId, sent.message_id, preorderContent.photoFileId);
        await orderWindow.openStageTwo();
      } else {
        await recordDingoPost(postMode, sent.message_id);
      }
    });

    await timer.step('deleteOld', async () => {
      for (const msgId of toDelete) {
        try {
          await bot.deleteMessage(channelId, msgId);
        } catch (error) {
          log('warn', 'dingo_delete_failed', { error: error.message });
        }
      }
    });

    await timer.step('advance', () => advanceNextHallToPost(halls, hallId, postMode));

    // Before the menu refresh: the serve list is what the admin is waiting on,
    // and it doesn't depend on the menu. The sequencer has already advanced,
    // which is all the refresh needs.
    if (postMode === 'here' && notifyChatId) {
      await timer.step('serveList', async () => {
        const hallOrders = await refreshHallServeOrdersCache(hall.name);

        if (hallOrders.length > 0) {
          const serveMsg = await bot.sendMessage(
            notifyChatId,
            HALL_SERVE_LIST_HEADER(hall.name),
            { reply_markup: buildHallCustomerListKeyboard(hall.name, hallOrders) }
          );
          await recordHallServeMessage(hall.name, notifyChatId, serveMsg.message_id);
        }
      });
    }

    // A cascade of automatic posts passes refreshMenus: false and refreshes
    // once itself when it is done (see autoAdvanceDeliveryStage).
    if (refreshMenus) {
      await timer.step('refreshMenus', () => refreshDeliveryModeMenus(bot));
    }

    if (postMode === 'get-ready') {
      await timer.step('notifyCustomers', () => notifyHallCustomers(
        bot,
        hall.name,
        `🔔 Get ready! The delivery is finishing up the current hall and ${hallLabel} is next. `
        + `Start heading down soon.`
      ));
    } else if (postMode === 'coming') {
      await timer.step('blockHall', () => blockHallForAutoClosure(bot, hall));
      await timer.step('notifyCustomers', () => notifyHallCustomers(
        bot,
        hall.name,
        `🚚 We're on our way to ${hallLabel} now! Come down and collect your order.`
      ));
    }

    return { posted: true, text, hall, hallLabel };
  } catch (error) {
    // Only the preorder text reads the food list; better no post than one
    // announcing "No food currently available" because a read blipped.
    if (isTemporarilyUnavailable(error)) {
      log('warn', 'dingo_post_sheets_unavailable', { error: error.message });
      return { posted: false, reason: 'sheets_unavailable' };
    }
    throw error;
  } finally {
    if (holder) {
      await timer.step('releaseLock', () => stateStore.releaseLock(stateStore.LOCKS.deliveryPost(), holder));
    }
    timer.done();
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
 *
 * Only the hall the pending post is gated on can drive it. Serving a late
 * order at an earlier hall (still listed, or reopened with Revert) used to
 * measure THAT hall's progress - often 100% - and fire the current hall's
 * get-ready/coming, closing ordering for the next hall far too early.
 */
async function autoAdvanceDeliveryStage(bot, hallName) {
  const halls = await googleSheets.getHalls();
  const hallIndex = halls.findIndex(hall => hall.name === hallName);

  if (hallIndex === -1) {
    log('warn', 'auto_advance_hall_not_found', { hall: hallName });
    return;
  }

  if (hallIndex === halls.length - 1) {
    return;
  }

  const progress = await orderStore.getHallServeProgress(hallName);

  // Each post in the cascade skips its own menu refresh (a full rebuild of the
  // admin menu, ~2s each); one refresh here covers them all. In a finally so
  // a failure or early return part-way through still leaves the menu current.
  let postedAny = false;

  try {
    for (let guard = 0; guard < 3; guard += 1) {
      const { hall: nextHall, mode } = await getNextHallToPostState(halls);
      const gatingHall = await getGatingHall(halls);

      if (!nextHall || !gatingHall || gatingHall.name !== hallName
        || !meetsAutoPostThreshold(mode, progress.fraction)) {
        return;
      }

      // Set before the call: a post that throws part-way may still have
      // advanced the sequencer, and the menu must reflect that.
      postedAny = true;
      const result = await postDingoUpdate(bot, { hallId: nextHall.id, postMode: mode, refreshMenus: false });

      if (!result.posted) {
        // Most likely 'locked' (a concurrent tap/tick got there first) or
        // 'stale' (someone else already advanced past this) - both harmless,
        // whatever holds the lock/is current will have driven this forward
        // itself. hall_not_found/no_channel/send_failed are not: those mean
        // this cascade silently stopped and nothing else will retry it, which
        // used to be untraceable. /skip (handleSkipCommand) is the manual
        // recovery for exactly this.
        if (result.reason !== 'locked' && result.reason !== 'stale') {
          log('warn', 'auto_advance_post_failed', {
            hall: hallName, next_hall: nextHall.name, mode, reason: result.reason,
          });
        }
        return;
      }
    }
  } finally {
    if (postedAny) {
      try {
        await refreshDeliveryModeMenus(bot);
      } catch (error) {
        // Never let a menu refresh hide the cascade's own error.
        log('warn', 'auto_advance_menu_refresh_failed', { error: error.message });
      }
    }
  }
}

// --- Ordering stages -----------------------------------------------------------
//
// A delivery night has two ordering stages (see services/orderWindow.js):
//   stage 1 - "orders open", posted around the target time, cut off sharply at
//             the cutoff time, so the rush happens before delivery starts;
//   stage 2 - "spare stock", posted once the drivers have left, for whatever
//             the drivers still carry.
// Stage 1 is posted from a reminder DM or the main admin menu. Stage 2 is the
// first button in Delivery Mode, behind a confirm-stock screen.

const STAGE1_CLOSED_POST_TEXT = '🔒 Ordering is now closed.\n\n'
  + 'Thanks everyone - our drivers are getting your food out to you! '
  + 'If we have any spares once we are on the road, we will post them here.';

const STAGE1_POST_FAILURES = {
  locked: 'A delivery update is already being posted - try again in a moment.',
  hall_not_found: 'No halls found - add a hall under Settings first.',
  no_channel: 'DINGO_CHANNEL_ID is not set in the environment.',
  send_failed: 'Failed to post to the Dingo channel. Check the channel ID and bot permissions.',
  sheets_unavailable: 'Could not read the menu. Nothing was posted - try again in a moment.',
};

/**
 * Post the stage-1 "orders open" message.
 *
 * Starts a new round, so last round is wrapped up first (orders closed, stock
 * restored, halls reopened - see runRoundReset) and any leftover posts from the
 * previous round are removed once the new post is out.
 */
async function postStageOne(bot, { notifyChatId = null } = {}) {
  const holder = await stateStore.acquireLock(stateStore.LOCKS.deliveryPost(), { leaseMs: 120000 });

  if (!holder) {
    return { posted: false, reason: 'locked' };
  }

  try {
    const channelId = config.telegram.dingoChannelId;

    if (!channelId) {
      return { posted: false, reason: 'no_channel' };
    }

    const halls = await googleSheets.getHalls({ fresh: true });

    if (!halls.length) {
      return { posted: false, reason: 'hall_not_found' };
    }

    await resetRoundBeforePreorder(bot, notifyChatId);

    const schedule = await orderWindow.getSchedule();
    const cutoffAt = orderWindow.nextOccurrence(orderWindow.nowSgt(), schedule.cutoffTime);
    const hall = halls[0];
    const content = await renderPreorderContent(bot, hall.shortName || hall.name, {
      stage: orderWindow.STAGES.STAGE1,
      cutoffAt: cutoffAt.toUTC().toISO(),
    });

    let sent;
    try {
      sent = await sendPreorderContent(bot, channelId, content);
    } catch (error) {
      log('error', 'stage1_post_failed', { error: error.message });
      return { posted: false, reason: 'send_failed' };
    }

    // Everything from the last round (old order post, coming/here posts) goes,
    // and the sequencer starts over; the new post is recorded after that.
    const oldIds = await consumeTrackedDingoMessageIds();
    await recordPreorderPost(channelId, sent.message_id, content.photoFileId);
    await orderWindow.openStageOne(schedule.cutoffTime);

    for (const messageId of oldIds) {
      try {
        await bot.deleteMessage(channelId, messageId);
      } catch (error) {
        log('warn', 'stage1_old_post_delete_failed', { error: error.message });
      }
    }

    await refreshDeliveryModeMenus(bot);
    return { posted: true, cutoffLabel: orderWindow.formatClock(schedule.cutoffTime) };
  } catch (error) {
    if (isTemporarilyUnavailable(error)) {
      log('warn', 'stage1_post_sheets_unavailable', { error: error.message });
      return { posted: false, reason: 'sheets_unavailable' };
    }
    throw error;
  } finally {
    await stateStore.releaseLock(stateStore.LOCKS.deliveryPost(), holder);
  }
}

async function runStageOnePost(bot, chatId, answer, actor = null) {
  const result = await postStageOne(bot, { notifyChatId: chatId });

  if (!result.posted) {
    await answer(STAGE1_POST_FAILURES[result.reason] || 'Could not post.', { show_alert: true });
    return true;
  }

  const postedBy = actor ? (actor.username ? `@${actor.username}` : actor.first_name || null) : null;
  await closeOrderReminders(bot, { postedBy, cutoffLabel: result.cutoffLabel });

  await answer('Orders are open!');
  await bot.sendMessage(
    chatId,
    `✅ Orders are open - posted to the Dingo channel. Ordering closes at ${result.cutoffLabel}.`
  );
  return true;
}

/**
 * Tonight's reminders to post stage 1: one 30 minutes before the target time
 * and one nudge at the target time, each only if stage 1 isn't out yet.
 * Called by the scheduled tick; marks a reminder sent before sending it so a
 * retried tick can't double-DM.
 */
async function runOrderReminders(bot, now = orderWindow.nowSgt()) {
  const [schedule, window, reminders] = await Promise.all([
    orderWindow.getSchedule(),
    orderWindow.getWindow(),
    stateStore.get(stateStore.KEYS.orderReminders(), null),
  ]);

  const action = orderWindow.reminderAction({ now, postTime: schedule.postTime, window, reminders });

  if (!action) {
    return null;
  }

  await orderWindow.markReminderSent(action, now);

  const when = orderWindow.formatClock(schedule.postTime);
  const text = action === 'remind'
    ? `⏰ Tonight's orders are due to go out at ${when} (in ${orderWindow.REMINDER_LEAD_MINUTES} minutes). `
      + 'Check the menu and stock, then tap below to post the "orders open" message.'
    : `⏰ It's ${when} - tonight's orders haven't been posted yet. Tap below to open ordering.`;

  const delivered = [];

  for (const adminId of googleSheets.getAdminIds()) {
    try {
      const sent = await bot.sendMessage(adminId, text, {
        reply_markup: { inline_keyboard: [[{ text: '📣 Post orders now', callback_data: CALLBACKS.STAGE1_POST }]] },
      });
      delivered.push({ chatId: adminId, messageId: sent.message_id });
    } catch (error) {
      log('warn', 'order_reminder_failed', { admin_id: adminId, error: error.message });
    }
  }

  // Remembered so that whoever posts first can clear the others' buttons.
  await stateStore.update(stateStore.KEYS.orderReminders(), current => ({
    ...(current || {}),
    messages: [...((current && current.messages) || []), ...delivered],
  }));

  return action;
}

/**
 * Stage 1 is out: turn every outstanding reminder DM into a "tonight's orders
 * have been posted" notice with no button, so another admin can't post again.
 */
async function closeOrderReminders(bot, { postedBy = null, cutoffLabel = null } = {}) {
  const reminders = await stateStore.get(stateStore.KEYS.orderReminders(), null);
  const messages = (reminders && reminders.messages) || [];

  if (!messages.length) {
    return;
  }

  await stateStore.set(stateStore.KEYS.orderReminders(), { ...reminders, messages: [] });

  const text = `✅ Tonight's orders have been posted${postedBy ? ` by ${postedBy}` : ''}.`
    + `${cutoffLabel ? ` Ordering closes at ${cutoffLabel}.` : ''}`;

  for (const { chatId, messageId } of messages) {
    try {
      await editMessageTextSafely(bot, text, {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: { inline_keyboard: [] },
      });
    } catch (error) {
      log('warn', 'order_reminder_close_failed', { chat_id: chatId, error: error.message });
    }
  }
}

/**
 * Close stage 1 once its cutoff has passed: the post is edited to say ordering
 * is closed and loses its button. Customers are already refused at the cutoff
 * itself (orderWindow.isOrderingOpen); this just makes the channel say so.
 */
async function enforceOrderCutoff(bot) {
  const window = await orderWindow.getWindow();

  if (!orderWindow.isPastCutoff(window)) {
    return { skipped: 'not_due' };
  }

  if (!await orderWindow.closeStageOne()) {
    return { skipped: 'already_closed' };
  }

  const result = await refreshPreorderPost(bot);
  await refreshDeliveryModeMenus(bot).catch(() => {});
  return { closed: true, post: result };
}

function formatScheduleText(schedule) {
  return '⏰ Order Schedule\n\n'
    + `• Target post time: ${orderWindow.formatClock(schedule.postTime)} `
    + `(admins are reminded ${orderWindow.REMINDER_LEAD_MINUTES} min before)\n`
    + `• Order cutoff: ${orderWindow.formatClock(schedule.cutoffTime)} (ordering stops sharply)\n\n`
    + 'Times are Singapore time.';
}

function scheduleKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '✏️ Edit target post time', callback_data: CALLBACKS.ORDER_SCHEDULE_EDIT_POST }],
      [{ text: '✏️ Edit order cutoff', callback_data: CALLBACKS.ORDER_SCHEDULE_EDIT_CUTOFF }],
      [{ text: '← Back', callback_data: CALLBACKS.ADMIN_SETTINGS }],
    ],
  };
}

async function showOrderSchedule(bot, chatId, userId, status = null) {
  const schedule = await orderWindow.getSchedule();
  await updateMenuMessage(
    bot, chatId, userId,
    formatScheduleText(schedule) + (status ? `\n\n${status}` : ''),
    scheduleKeyboard()
  );
}

/** The admin's typed reply to an "Edit target post time / cutoff" prompt. */
async function handleScheduleInput(bot, chatId, userId, text, state, messageId) {
  const time = orderWindow.parseClock(text);

  if (!time) {
    await bot.sendMessage(chatId, '❌ I could not read that time. Try something like 6pm, 6:30 PM or 18:00.');
    return true;
  }

  const isPostTime = state === STATES.EDIT_POST_TIME;
  await orderWindow.setSchedule(isPostTime ? { postTime: time } : { cutoffTime: time });
  await clearAdminState(userId);

  try {
    await bot.deleteMessage(chatId, messageId);
  } catch (error) {
    log('warn', 'schedule_input_delete_failed', { error: error.message });
  }

  let status = `✅ Saved - ${isPostTime ? 'target post time' : 'order cutoff'} is now ${orderWindow.formatClock(time)}.`;

  // A cutoff change applies to the round that is live right now, and the
  // channel post shows it, so refresh that too.
  if (!isPostTime && await orderWindow.recomputeCutoff(time)) {
    await refreshPreorderPost(bot);
    status += ' The live orders post has been updated.';
  }

  await showOrderSchedule(bot, chatId, userId, status);
  return true;
}


// --- Stage 2: confirm stock, then post spare stock -----------------------------

async function getStagePanel() {
  return stateStore.get(stateStore.KEYS.stagePanel(), null);
}

async function setStagePanel(value) {
  return stateStore.set(stateStore.KEYS.stagePanel(), value, { ttlMs: 2 * 60 * 60 * 1000 });
}

function buildStagePanelText(items, adjust) {
  const lines = items.map(item => {
    const { total, sold, remaining } = orderWindow.stockFigures(item, adjust);
    return `• ${item.name}\n   total ${total} · sold ${sold} · remaining ${remaining}`;
  });

  return '📣 Confirm stock before posting spare stock\n\n'
    + (lines.length ? lines.join('\n') : 'No menu items.')
    + '\n\n"Sold" is what stage-1 orders took. Tap an item to change its total, '
    + 'or confirm to post the remaining stock to the channel.';
}

function buildStagePanelKeyboard(items) {
  return {
    inline_keyboard: [
      ...items.map(item => [{
        text: `✏️ ${item.name}`,
        callback_data: `${CALLBACKS.STAGE2_EDIT_PREFIX}${item.id}`,
      }]),
      [{ text: '✅ Confirm & post', callback_data: CALLBACKS.STAGE2_CONFIRM }],
      [{ text: '✖️ Cancel', callback_data: CALLBACKS.STAGE2_CANCEL }],
    ],
  };
}

async function renderStagePanel(bot, chatId, userId) {
  const panel = await getStagePanel();
  const items = await menuStore.getFoodItemsOrThrow();
  await updateMenuMessage(
    bot, chatId, userId,
    buildStagePanelText(items, panel ? panel.adjust : {}),
    buildStagePanelKeyboard(items)
  );
}

/**
 * The Delivery Mode "Confirm stock & post" button (and /skip at that stage):
 * show the stock screen instead of posting straight away.
 *
 * If stage 1 was never posted this round, nothing has reset last round yet, so
 * that happens first - otherwise the totals here would be last night's.
 */
async function showStageTwoPanel(bot, chatId, userId, hallId, answer) {
  const window = await orderWindow.getWindow();

  if (window && window.stage === orderWindow.STAGES.STAGE2) {
    await answer('Spare stock has already been posted.', { show_alert: true });
    return true;
  }

  try {
    if (!window) {
      await resetRoundBeforePreorder(bot, chatId);
      await orderWindow.setWindow({ stage: orderWindow.STAGES.CLOSED, postedAt: null, cutoffAt: null });
    }

    await setStagePanel({ hallId, adjust: {} });
    await clearAdminState(userId);
    await renderStagePanel(bot, chatId, userId);
  } catch (error) {
    if (!isTemporarilyUnavailable(error)) {
      throw error;
    }
    await answer('Could not read the menu. Try again in a moment.', { show_alert: true });
    return true;
  }

  await answer();
  return true;
}

/** The admin's typed new total for one item on the confirm-stock screen. */
async function handleStageTwoStockInput(bot, chatId, userId, text, state, messageId) {
  const trimmed = String(text || '').trim();

  if (!/^\d+$/.test(trimmed)) {
    await bot.sendMessage(chatId, '❌ Please type a whole number, like 12.');
    return true;
  }

  const total = Number.parseInt(trimmed, 10);
  const panel = await getStagePanel();
  const items = await menuStore.getFoodItems();
  const item = items.find(entry => entry.id === state.foodItemId);

  if (!panel || !item) {
    await clearAdminState(userId);
    await bot.sendMessage(chatId, 'That screen has expired - open Delivery Mode again.');
    return true;
  }

  const { sold, hasBaseline } = orderWindow.stockFigures(item, panel.adjust);

  if (total < sold) {
    await bot.sendMessage(
      chatId,
      `❌ ${total} is too low - ${sold} of ${item.name} ${sold === 1 ? 'was' : 'were'} already sold in stage 1. `
      + `Type a new total (at least ${sold}).`
    );
    return true;
  }

  const saved = await menuStore.setRemainingStock(item.id, total - sold);

  if (!saved.success) {
    await bot.sendMessage(chatId, `${saved.message}\n\nType the total for ${item.name} again.`);
    return true;
  }

  if (hasBaseline) {
    await setStagePanel({ ...panel, adjust: { ...panel.adjust, [item.id]: total - item.baselineStock } });
  }

  await clearAdminState(userId);

  try {
    await bot.deleteMessage(chatId, messageId);
  } catch (error) {
    log('warn', 'stage2_stock_input_delete_failed', { error: error.message });
  }

  await renderStagePanel(bot, chatId, userId);
  return true;
}

async function handleStageCallbacks(bot, query, chatId, userId, data, answer) {
  // --- stage 1 ---
  if (data === CALLBACKS.STAGE1_POST) {
    if (await orderWindow.getWindow()) {
      await bot.sendMessage(
        chatId,
        '⚠️ Orders have already been posted for this round. Posting again starts a NEW round: '
        + 'unpaid orders are closed and restocked, stock goes back to opening levels and halls reopen.',
        {
          reply_markup: {
            inline_keyboard: [[
              { text: '✅ Start a new round', callback_data: CALLBACKS.STAGE1_POST_CONFIRM },
              { text: '✖️ Cancel', callback_data: CALLBACKS.STAGE1_POST_CANCEL },
            ]],
          },
        }
      );
      await answer();
      return true;
    }

    return runStageOnePost(bot, chatId, answer, query.from);
  }

  if (data === CALLBACKS.STAGE1_POST_CONFIRM || data === CALLBACKS.STAGE1_POST_CANCEL) {
    try {
      await bot.deleteMessage(chatId, query.message.message_id);
    } catch (error) {
      log('warn', 'stage1_prompt_delete_failed', { error: error.message });
    }

    if (data === CALLBACKS.STAGE1_POST_CANCEL) {
      await answer();
      return true;
    }

    return runStageOnePost(bot, chatId, answer, query.from);
  }

  // --- Settings > Order Schedule ---
  if (data === CALLBACKS.SETTINGS_ORDER_SCHEDULE) {
    await clearAdminState(userId);
    await showOrderSchedule(bot, chatId, userId);
    await answer();
    return true;
  }

  if (data === CALLBACKS.ORDER_SCHEDULE_EDIT_POST || data === CALLBACKS.ORDER_SCHEDULE_EDIT_CUTOFF) {
    const isPostTime = data === CALLBACKS.ORDER_SCHEDULE_EDIT_POST;
    await setAdminState(userId, isPostTime ? STATES.EDIT_POST_TIME : STATES.EDIT_CUTOFF_TIME);
    await updateMenuMessage(
      bot, chatId, userId,
      `Send the new ${isPostTime ? 'target post time' : 'order cutoff'}, e.g. ${isPostTime ? '6pm or 18:00' : '12:30am or 00:30'}.`,
      { inline_keyboard: [[{ text: '← Back', callback_data: CALLBACKS.SETTINGS_ORDER_SCHEDULE }]] }
    );
    await answer();
    return true;
  }

  // --- stage 2 ---
  if (isCallbackType(data, CALLBACKS.STAGE2_EDIT_PREFIX)) {
    const foodItemId = Number.parseInt(extractCallbackValue(data, CALLBACKS.STAGE2_EDIT_PREFIX), 10);
    const panel = await getStagePanel();
    const item = (await menuStore.getFoodItems()).find(entry => entry.id === foodItemId);

    if (!panel || !item) {
      await answer('This screen is outdated - open Delivery Mode again.', { show_alert: true });
      return true;
    }

    const { total, sold, remaining } = orderWindow.stockFigures(item, panel.adjust);
    await setAdminState(userId, { mode: STATES.EDIT_STAGE2_STOCK, foodItemId });
    await updateMenuMessage(
      bot, chatId, userId,
      `✏️ ${item.name}\ntotal ${total} · sold ${sold} · remaining ${remaining}\n\n`
      + `Type the new TOTAL stock (at least ${sold}, what is already sold).`,
      { inline_keyboard: [[{ text: '← Back', callback_data: CALLBACKS.STAGE2_BACK }]] }
    );
    await answer();
    return true;
  }

  if (data === CALLBACKS.STAGE2_BACK) {
    await clearAdminState(userId);

    if (!await getStagePanel()) {
      await answer('This screen is outdated - open Delivery Mode again.', { show_alert: true });
      return true;
    }

    await renderStagePanel(bot, chatId, userId);
    await answer();
    return true;
  }

  if (data === CALLBACKS.STAGE2_CANCEL) {
    await clearAdminState(userId);
    await stateStore.remove(stateStore.KEYS.stagePanel());
    await showDeliveryModeMenu(bot, chatId, userId);
    await answer();
    return true;
  }

  if (data === CALLBACKS.STAGE2_CONFIRM) {
    const panel = await getStagePanel();

    if (!panel) {
      await answer('This screen is outdated - open Delivery Mode again.', { show_alert: true });
      return true;
    }

    await clearAdminState(userId);

    const posted = await performDeliveryPost(
      bot, query, chatId,
      `${CALLBACKS.DELIVERY_MODE_POST_CHANNEL_PREFIX}preorder:${panel.hallId}`
    );

    if (posted.posted) {
      await stateStore.remove(stateStore.KEYS.stagePanel());
      await showDeliveryModeMenu(bot, chatId, userId);
    }
    return true;
  }

  return false;
}


/**
 * A Delivery Mode post button. The first step (spare stock) goes through the
 * confirm-stock screen; the rest post straight away.
 */
async function handleDeliveryPost(bot, query, chatId, userId, data) {
  const [postMode, hallIdValue] = extractCallbackValue(data, CALLBACKS.DELIVERY_MODE_POST_CHANNEL_PREFIX).split(':');

  if (postMode === 'preorder') {
    const answer = (text, options) => bot.answerCallbackQuery(query.id, { ...options, text });
    return showStageTwoPanel(bot, chatId, userId, Number.parseInt(hallIdValue, 10), answer);
  }

  await performDeliveryPost(bot, query, chatId, data);
  return true;
}

/** Post for a Delivery Mode button and answer the tap. Resolves { posted }. */
async function performDeliveryPost(bot, query, chatId, data) {
  const [postMode, hallIdValue] = extractCallbackValue(data, CALLBACKS.DELIVERY_MODE_POST_CHANNEL_PREFIX).split(':');
  const hallId = Number.parseInt(hallIdValue, 10);

  const timer = createStepTimer('delivery_post_tap', { mode: postMode });

  // Answered as soon as the channel post is out (see postDingoUpdate's
  // onPosted), since Telegram allows one answer per query. Failures never reach
  // onPosted, so they still get their specific alert below.
  let answered = false;
  const answerPosted = async ({ text }) => {
    answered = true;
    await bot.answerCallbackQuery(
      query.id,
      { text: postMode === 'preorder' ? 'Posted spare stock to Dingo channel.' : `Posted to Dingo channel: ${text}` }
    );
  };

  const result = await timer.step('post', () => postDingoUpdate(bot, { hallId, postMode, notifyChatId: chatId, onPosted: answerPosted }));

  if (!result.posted) {
    const FAILURE_RESPONSES = {
      locked: { text: 'A delivery update is already being posted.' },
      hall_not_found: { text: 'Hall not found', show_alert: true },
      stale: { text: 'This button is outdated. Please use the latest delivery menu.', show_alert: true },
      no_channel: { text: 'DINGO_CHANNEL_ID is not set in the environment.', show_alert: true },
      send_failed: { text: 'Failed to post to the Dingo channel. Check the channel ID and bot permissions.', show_alert: true },
      sheets_unavailable: { text: 'Could not read the menu. Nothing was posted - try again in a moment.', show_alert: true },
    };

    timer.done();
    await bot.answerCallbackQuery(query.id, FAILURE_RESPONSES[result.reason] || { text: 'Could not post update.', show_alert: true });
    return { posted: false };
  }

  if (!answered) {
    await answerPosted(result);
  }

  if (postMode === 'here') {
    // The lock from the post above is already released by now, so this is
    // free to take it again for whatever it posts (e.g. a hall nobody
    // ordered from, whose get-ready/coming can fire immediately).
    await timer.step('autoAdvance', () => autoAdvanceDeliveryStage(bot, result.hall.name));
  }

  timer.done();
  return { posted: true };
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

/** "📦 Dropped off" on one order within a customer's submenu: ask for the photo first. */
async function handleSubmenuDropoffStart(bot, query, chatId, messageId, orderId) {
  // Despite its name, getPendingOrder is a plain lookup by id.
  const order = await orderStore.getPendingOrder(orderId);

  if (!order || order.servedAt) {
    await bot.answerCallbackQuery(query.id, { text: 'Order is already served or no longer active.' });
    return true;
  }

  await stateStore.set(
    stateStore.KEYS.awaitingDropoffPhoto(query.from.id),
    {
      hallName: order.hallName,
      telegramUserId: order.userId,
      customerChatId: order.chatId,
      orderIds: [order.id],
    },
    { ttlMs: 15 * 60 * 1000 }
  );

  await bot.sendMessage(
    chatId,
    `📸 Send a photo showing where you left order ${order.code}:\n\n${formatOrderItems(order)}\n\n`
    + "I'll forward it to the customer and mark the order dropped off."
  );

  await bot.answerCallbackQuery(query.id);
  return true;
}

/** "✅ Served" / "📦 Dropped off" on one order within a customer's submenu. */
async function handleServeMarkOrder(bot, query, chatId, messageId, data, kind) {
  const prefix = kind === 'served'
    ? CALLBACKS.DELIVERY_MODE_SERVE_MARK_SERVED_PREFIX
    : CALLBACKS.DELIVERY_MODE_SERVE_MARK_DROPPED_PREFIX;
  const orderId = extractCallbackValue(data, prefix);

  // Every drop-off needs a photo of where the food was left, so this button
  // only starts the same photo relay as the remaining-items screen, scoped to
  // this one order. The order is marked once the photo arrives.
  if (kind === 'dropped_off') {
    return handleSubmenuDropoffStart(bot, query, chatId, messageId, orderId);
  }

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
    try {
      await bot.deleteMessage(chatId, messageId);
    } catch (error) {
      log('warn', 'hall_serve_message_delete_failed', { hall: served.hallName, error: error.message });
    }

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
    try {
      await bot.deleteMessage(tracked.chatId, tracked.messageId);
    } catch (error) {
      log('warn', 'hall_serve_message_delete_failed', { hall: hallName, error: error.message });
    }
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

/**
 * Move this chat's hall "Tap a phone number" lists back below the delivery
 * mode menu.
 *
 * Only called when the admin opens the menu themselves, which may repost it
 * to the bottom of the chat (see deliveryMode.sendDeliveryModeMenu) and so
 * leapfrog it past a serve list. Background refreshes edit both messages in
 * place instead and never call this - doing it on every refresh used to
 * delete and resend both messages on every order, payment and served tap.
 */
async function repositionHallServeMessagesBelowMenu(bot, chatId) {
  const halls = await getHalls();

  for (const hall of halls) {
    const tracked = await getHallServeMessage(hall.name);

    if (!tracked || Number(tracked.chatId) !== Number(chatId)
      || await isMessageLatestInChat(tracked.chatId, tracked.messageId)) {
      continue;
    }

    const hallOrders = await refreshHallServeOrdersCache(hall.name);

    if (hallOrders.length === 0) {
      try {
        await bot.deleteMessage(tracked.chatId, tracked.messageId);
      } catch (error) {
        log('warn', 'hall_serve_message_delete_failed', { hall: hall.name, error: error.message });
      }
      await clearHallServeMessage(hall.name);
      continue;
    }

    try {
      await bot.deleteMessage(tracked.chatId, tracked.messageId);
    } catch (error) {
      log('warn', 'hall_serve_message_reposition_delete_failed', { hall: hall.name, error: error.message });
    }

    try {
      const resent = await bot.sendMessage(
        tracked.chatId,
        HALL_SERVE_LIST_HEADER(hall.name),
        { reply_markup: buildHallCustomerListKeyboard(hall.name, hallOrders) }
      );
      await recordHallServeMessage(hall.name, tracked.chatId, resent.message_id);
    } catch (error) {
      log('warn', 'hall_serve_message_reposition_send_failed', { hall: hall.name, error: error.message });
    }
  }
}

/** Background refresh of every open delivery menu, edited in place. */
async function refreshDeliveryModeMenus(bot) {
  await refreshDeliveryModeMenusOnly(bot);
}

/**
 * "📋 Serve list: Hall X" - (re)send a visited hall's serve list without
 * posting anything to the channel. The list is otherwise only created by that
 * hall's "we are here" post, so late orders (or ones placed after Revert)
 * had no way to be served once its list was gone.
 */
async function handleServeListResend(bot, chatId, hallName, answer) {
  const hallOrders = await refreshHallServeOrdersCache(hallName);

  if (!hallOrders.length) {
    await answer(`No unserved orders left at ${hallName}.`);
    await refreshDeliveryModeMenus(bot);
    return true;
  }

  // One live list per hall: replace an older copy rather than leave two
  // whose buttons race each other.
  const previous = await getHallServeMessage(hallName);
  if (previous) {
    try {
      await bot.deleteMessage(previous.chatId, previous.messageId);
    } catch (error) {
      log('warn', 'serve_list_previous_delete_failed', { hall: hallName, error: error.message });
    }
  }

  const sent = await bot.sendMessage(
    chatId,
    HALL_SERVE_LIST_HEADER(hallName),
    { reply_markup: buildHallCustomerListKeyboard(hallName, hallOrders) }
  );
  await recordHallServeMessage(hallName, chatId, sent.message_id);
  await answer();
  return true;
}

const FINISH_TEXT ='✅ Delivery finished. Halls and orders will reset automatically when the next preorder is posted.';

/**
 * Reset for a new delivery round: close out anything still active from the
 * last one, rewind the hall sequencer back to the first hall, and drop the
 * per-hall serve caches so the delivery menu and "we are here" lists start
 * clean instead of carrying over whatever the sequencer/cache last held.
 *
 * Runs automatically as the preorder post goes out (see postDingoUpdate), so
 * it never asks for confirmation. Returns the summary text for the admins.
 */
async function runRoundReset(bot) {
  const leftoverOrders = await orderStore.getActiveOrders();
  const closedSummaries = [];
  const awaitingReview = [];

  for (const order of leftoverOrders) {
    // A receipt still being checked, or waiting on an admin, means the
    // customer has most likely paid. Closing it as "round ended before
    // payment was completed" (and restocking) was both wrong and a lost
    // payment - leave it for its review card instead.
    if (order.status === STATUS.PAYMENT_FLAGGED || order.status === STATUS.VERIFYING_PAYMENT) {
      awaitingReview.push(`🏢 ${order.hallName}: ${order.code} - ${orderActions.describeCustomer(order)}`);
      continue;
    }

    const closed = await orderActions.closeLeftoverOrder(bot, order);

    if (closed) {
      const items = (order.items || []).map(item => `${item.name} x${item.quantity}`).join(', ');
      closedSummaries.push(
        `🏢 ${order.hallName}: ${orderActions.describeCustomer(order)} - ${items} `
        + `(${order.status === STATUS.PAID ? 'paid' : 'unpaid'})`
      );
    }
  }

  // Orders already handed over before their payment cleared. They are no
  // longer active, so they are looked up separately; best-effort, the reset
  // must not fail because of a summary line.
  let servedUnpaid = [];
  try {
    servedUnpaid = await orderStore.getRecentServedUnpaidOrders();
  } catch (error) {
    log('warn', 'reset_served_unpaid_lookup_failed', { error: error.message });
  }

  // Put stock back to whatever an admin last manually set it to (see
  // menuStore.updateFoodItemStock), undoing the night's consumption - not a
  // running "add back what was rejected" total, the actual opening number. One
  // atomic statement in the database, so a checkout landing mid-reset can't be
  // clobbered by it.
  const { changes: stockChanges, noBaselineItems } = await menuStore.restoreStockBaselines();

  await setSequencer({ ...DEFAULT_SEQUENCER });

  const halls = await getHalls();
  for (const hall of halls) {
    await clearHallServeMessage(hall.name);
    await stateStore.remove(stateStore.KEYS.hallServeOrdersCache(hall.name));
  }

  await orderStore.clearBlockedHalls();
  await refreshPreorderPostAfterStockChange(bot, stockChanges);
  await refreshDeliveryModeMenus(bot);

  const closedText = closedSummaries.length
    ? `\n\nClosed leftover orders:\n${closedSummaries.join('\n')}`
    : '';

  const servedUnpaidText = servedUnpaid.length
    ? '\n\n💸 Served but never paid (reconcile if needed):\n'
      + servedUnpaid.map(order => `🏢 ${order.hallName}: ${order.code} - ${orderActions.describeCustomer(order)}`).join('\n')
    : '';

  const stockText = stockChanges.length
    ? `\n\nStock reset to opening levels:\n${stockChanges.map(c => `${c.name}: ${c.oldStock} → ${c.newStock}`).join('\n')}`
    : '';

  const reviewText = awaitingReview.length
    ? `\n\n👀 Left open - payment still needs a decision (use each order's review card):\n${awaitingReview.join('\n')}`
    : '';

  const noBaselineText = noBaselineItems.length
    ? `\n\n⚠️ No starting stock recorded for: ${noBaselineItems.join(', ')} - left unchanged.`
    : '';

  return '✅ Halls and orders were reset for the new round. Orders are now available to be placed by any hall, '
    + `starting from ${halls[0] ? halls[0].name : 'the first hall'}.`
    + `${closedText}${servedUnpaidText}${reviewText}${stockText}${noBaselineText}`;
}

/**
 * The reset as the preorder post triggers it: under the reset lock (so two
 * posts racing can't both run it), then the summary goes to the admin who
 * triggered the post, or to every admin when nobody did (the cron tick).
 * A failure is logged and swallowed - a half-reset must not stop tonight's
 * preorder from going out, and the summary says nothing false about it.
 */
async function resetRoundBeforePreorder(bot, notifyChatId) {
  const holder = await stateStore.acquireLock(stateStore.LOCKS.deliveryReset(), { leaseMs: 120000 });

  if (!holder) {
    return;
  }

  let summary;
  try {
    summary = await runRoundReset(bot);
  } catch (error) {
    log('error', 'round_reset_failed', { error: error.message });
    summary = `⚠️ The automatic reset for the new round failed (${error.message}). `
      + 'The preorder was still posted - some orders or stock may not have been reset.';
  } finally {
    await stateStore.releaseLock(stateStore.LOCKS.deliveryReset(), holder);
  }

  const recipients = notifyChatId ? [notifyChatId] : googleSheets.getAdminIds();

  for (const recipient of recipients) {
    try {
      await bot.sendMessage(recipient, summary);
    } catch (error) {
      log('warn', 'round_reset_summary_failed', { error: error.message, chat_id: recipient });
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

  await bot.sendMessage(chatId, FINISH_TEXT);

  await showMainAdminMenu(bot, chatId, userId);
  return true;
}

module.exports = {
  handleAdminCommand,
  handleAdminCallback,
  handleSkipCommand,
  handleStatusCommand,
  runRoundReset,
  resetRoundBeforePreorder,
  postStageOne,
  runOrderReminders,
  closeOrderReminders,
  enforceOrderCutoff,
  showStageTwoPanel,
  handleStageCallbacks,
  handleStageTwoStockInput,
  handleScheduleInput,
  handleServeListResend,
  refreshPreorderPost,
  refreshHallServeOrdersMessage,
  refreshDeliveryModeMenus,
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
  handleAdminPreorderPhoto,
  handlePreorderPostCallback,
  buildPreorderIntro,
  renderPreorderContent,
  getPreorderCustom,
  PREORDER_CUSTOM_TEXT_MAX_LENGTH,
};
