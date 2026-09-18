const { getHalls, getFoodItems } = require('../services/googleSheets');
const keyboards = require('../utils/keyboards');
const menuTexts = require('../utils/menuTexts');
const orderStore = require('../services/orderStore');
const stateStore = require('../services/stateStore');
const { getSupabase, unwrap } = require('../services/supabase');
const {
  noteChatMessage,
  isMessageLatestInChat,
  getMenuMessageId,
  setMenuMessageId,
} = require('../services/chatTracker');
const { log } = require('../utils/logger');

/**
 * Delivery mode: the sequencer that walks each hall through its channel
 * announcements and tracks which orders still need serving.
 *
 * Behaviour is unchanged from the original. What changed is where the state
 * lives: the sequencer position, the posted channel message ids and the list of
 * admins currently viewing the menu were all module-level variables, which do
 * not survive a serverless instance ending.
 */

const DEFAULT_SEQUENCER = { index: 0, mode: 'preorder' };

async function getSequencer() {
  return stateStore.get(stateStore.KEYS.deliverySequencer(), DEFAULT_SEQUENCER);
}

async function setSequencer(value) {
  return stateStore.set(stateStore.KEYS.deliverySequencer(), value);
}

async function getDingoPosts() {
  return stateStore.get(stateStore.KEYS.dingoPosts(), { coming: null, here: null, 'get-ready': null });
}

async function setDingoPosts(value) {
  return stateStore.set(stateStore.KEYS.dingoPosts(), value);
}

async function recordPreorderPost(channelId, msgId) {
  return stateStore.set(stateStore.KEYS.preorderPost(), {
    channelId: String(channelId),
    msgId,
    contentHash: null,
  });
}

async function getPreorderPost() {
  return stateStore.get(stateStore.KEYS.preorderPost(), { channelId: null, msgId: null, contentHash: null });
}

/**
 * Whether ordering is open. Gated on a preorder post existing, exactly as
 * before - the difference is that this is now durable, so a redeploy no longer
 * silently closes ordering mid-run.
 */
async function hasPreorderPost() {
  const post = await getPreorderPost();
  return Boolean(post && post.msgId);
}

async function recordDingoPost(mode, msgId) {
  const posts = await getDingoPosts();
  posts[mode] = msgId;
  return setDingoPosts(posts);
}

/**
 * Which previously-posted channel messages this new post supersedes.
 *
 * Unchanged logic: posting "we are here" clears the "coming" message, and
 * posting "coming" for the next hall clears the previous "here"/"get ready".
 */
async function getDingoMsgIdsToDelete(mode) {
  const posts = await getDingoPosts();
  const toDelete = [];

  if (mode === 'here') {
    if (posts.coming) toDelete.push(posts.coming);
    posts.coming = null;
  } else if (mode === 'coming') {
    if (posts.here) toDelete.push(posts.here);
    if (posts['get-ready']) toDelete.push(posts['get-ready']);
    posts.here = null;
    posts['get-ready'] = null;
  }

  await setDingoPosts(posts);
  return toDelete;
}

/** Collect every tracked channel message id and reset the sequencer. */
async function consumeTrackedDingoMessageIds() {
  const posts = await getDingoPosts();
  const preorder = await getPreorderPost();

  const ids = [preorder.msgId, posts.coming, posts.here, posts['get-ready']].filter(Boolean);

  await setDingoPosts({ coming: null, here: null, 'get-ready': null });
  await stateStore.remove(stateStore.KEYS.preorderPost());
  await setSequencer({ ...DEFAULT_SEQUENCER });

  return [...new Set(ids)];
}

/**
 * Track the "Tap each order when served" message sent for a hall, so a new
 * order placed for that hall afterwards can be added to it live instead of
 * only ever reflecting a snapshot taken at "we are here" time.
 */
async function recordHallServeMessage(hallName, chatId, messageId) {
  return stateStore.set(stateStore.KEYS.hallServeMessage(hallName), { chatId, messageId });
}

async function getHallServeMessage(hallName) {
  return stateStore.get(stateStore.KEYS.hallServeMessage(hallName), null);
}

async function clearHallServeMessage(hallName) {
  return stateStore.remove(stateStore.KEYS.hallServeMessage(hallName));
}

async function getNextHallToPostState(halls) {
  const sequencer = await getSequencer();

  if (!halls.length) {
    return { hall: null, mode: sequencer.mode };
  }

  const index = sequencer.index % halls.length;
  return { hall: halls[index], mode: sequencer.mode };
}

async function isExpectedNextHallToPost(halls, hallId, mode) {
  const { hall, mode: currentMode } = await getNextHallToPostState(halls);
  return Boolean(hall) && hall.id === hallId && currentMode === mode;
}

/**
 * The hall whose serve progress gates the pending post, when that post is
 * 'get-ready' or 'coming' - both fired automatically now, off that hall
 * reaching a serve-progress threshold. Null for 'preorder'/'here', which stay
 * manual and have no such dependency, so the admin menu knows when there's
 * simply nothing to show a countdown for.
 */
async function getGatingHall(halls) {
  const sequencer = await getSequencer();

  if (!halls.length || !['get-ready', 'coming'].includes(sequencer.mode)) {
    return null;
  }

  const index = sequencer.index % halls.length;
  const gatingIndex = (index - 1 + halls.length) % halls.length;
  return halls[gatingIndex];
}

/**
 * Advance the sequencer after a successful post.
 *
 * The cycle per hall is preorder -> coming -> here, then get-ready for the next
 * hall. Logic is a direct port of the original.
 */
async function advanceNextHallToPost(halls, currentHallId, currentMode) {
  if (!halls.length) {
    await setSequencer({ index: 0, mode: 'coming' });
    return { hall: null, mode: 'coming' };
  }

  if (halls.length === 1) {
    await setSequencer({ index: 0, mode: 'coming' });
    return { hall: halls[0], mode: 'coming' };
  }

  const currentIndex = halls.findIndex(hall => hall.id === currentHallId);

  if (currentIndex === -1) {
    const sequencer = await getSequencer();
    const index = sequencer.index % halls.length;
    return { hall: halls[index], mode: sequencer.mode };
  }

  let next;

  if (currentMode === 'get-ready') {
    next = { index: currentIndex, mode: 'coming' };
  } else if (currentMode === 'preorder') {
    next = { index: currentIndex, mode: 'coming' };
  } else if (currentMode === 'coming') {
    next = { index: currentIndex, mode: 'here' };
  } else {
    next = { index: (currentIndex + 1) % halls.length, mode: 'get-ready' };
  }

  await setSequencer(next);
  return { hall: halls[next.index], mode: next.mode };
}


// --- Menu rendering ----------------------------------------------------------

async function getDeliveryModeView() {
  const halls = await getHalls();
  const foodItems = await getFoodItems();
  const orders = await orderStore.getActiveOrders();
  const blocked = await orderStore.loadBlockedHalls();

  const { hall: nextHallToPost, mode } = await getNextHallToPostState(halls);
  const allHallsBlocked = halls.length > 0 && halls.every(hall => blocked.isBlocked(hall.name));

  const gatingHall = await getGatingHall(halls);
  const gatingProgress = gatingHall ? await orderStore.getHallServeProgress(gatingHall.name) : null;

  const hallHasNoOrders = mode === 'here' && nextHallToPost
    ? !orders.some(order => order.hallName === nextHallToPost.name)
    : false;

  return {
    text: menuTexts.deliveryModeText(halls, orders, foodItems, {
      nextHallToPost,
      mode,
      gatingHall,
      gatingProgress,
    }),
    keyboard: keyboards.deliveryModeKeyboard(nextHallToPost, mode, blocked.last, allHallsBlocked, hallHasNoOrders),
  };
}

async function setDeliveryModeViewer(userId, chatId) {
  // Expires so an admin who wandered off does not keep being refreshed forever.
  await stateStore.set(stateStore.KEYS.deliveryViewer(userId), { chatId }, { ttlMs: 12 * 60 * 60 * 1000 });
}

async function clearDeliveryModeViewer(userId) {
  await stateStore.remove(stateStore.KEYS.deliveryViewer(userId));
}

async function listDeliveryModeViewers() {
  const supabase = getSupabase();

  const rows = unwrap(
    await supabase
      .from('bot_state')
      .select('key, value, expires_at')
      .like('key', 'delivery:viewer:%'),
    'listDeliveryModeViewers'
  );

  const now = Date.now();

  return (rows || [])
    .filter(row => !row.expires_at || new Date(row.expires_at).getTime() > now)
    .map(row => ({
      userId: row.key.replace('delivery:viewer:', ''),
      chatId: row.value && row.value.chatId,
    }))
    .filter(viewer => viewer.chatId);
}

async function sendDeliveryModeMenu(bot, chatId, userId) {
  const { text, keyboard } = await getDeliveryModeView();
  const currentMessageId = await getMenuMessageId(userId);

  // Edit in place while the menu is still the newest message in the chat;
  // otherwise repost so it stays at the bottom where the admin is looking.
  if (currentMessageId && await isMessageLatestInChat(chatId, currentMessageId)) {
    try {
      await bot.editMessageText(text, {
        chat_id: chatId,
        message_id: currentMessageId,
        reply_markup: keyboard,
      });
      await setDeliveryModeViewer(userId, chatId);
      return;
    } catch (error) {
      if (String(error.message || '').includes('message is not modified')) {
        await setDeliveryModeViewer(userId, chatId);
        return;
      }
      log('warn', 'delivery_menu_edit_failed', { error: error.message });
    }
  }

  if (currentMessageId) {
    try {
      await bot.deleteMessage(chatId, currentMessageId);
    } catch (error) {
      log('warn', 'delivery_menu_delete_failed', { error: error.message });
    }
  }

  const sent = await bot.sendMessage(chatId, text, { reply_markup: keyboard });
  await setMenuMessageId(userId, sent.message_id);
  await noteChatMessage(chatId, sent.message_id);
  await setDeliveryModeViewer(userId, chatId);
}

async function showDeliveryModeMenu(bot, chatId, userId) {
  await sendDeliveryModeMenu(bot, chatId, userId);
}

/**
 * Re-render the delivery menu for every admin currently viewing it.
 *
 * Called after anything that changes what the menu shows, which is what
 * replaces the old 5-second polling loop.
 */
async function refreshDeliveryModeMenus(bot) {
  const viewers = await listDeliveryModeViewers();

  for (const viewer of viewers) {
    try {
      await sendDeliveryModeMenu(bot, viewer.chatId, viewer.userId);
    } catch (error) {
      await clearDeliveryModeViewer(viewer.userId);
      log('warn', 'delivery_menu_refresh_failed', { error: error.message });
    }
  }
}

module.exports = {
  DEFAULT_SEQUENCER,
  getSequencer,
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
  hasPreorderPost,
  getDeliveryModeView,
  showDeliveryModeMenu,
  sendDeliveryModeMenu,
  setDeliveryModeViewer,
  clearDeliveryModeViewer,
  listDeliveryModeViewers,
  refreshDeliveryModeMenus,
  noteChatMessage,
};
