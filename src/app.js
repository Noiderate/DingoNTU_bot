const TelegramBot = require('node-telegram-bot-api');
const { config, assertRequiredConfig } = require('./config');
const { noteChatMessage, isMessageLatestInChat } = require('./services/chatTracker');
const { isAdmin, ensureAdminIdsLoaded } = require('./services/googleSheets');
const {
  handleAdminCommand, handleAdminCallback, handleAdminDropoffPhoto, handleAdminPreorderPhoto,
} = require('./handlers/admin');
const { handleUserCommand, handleUserCallback, handleUserPhoto, sendFallbackHint } = require('./handlers/user');
const { isImageDocument } = require('./utils/telegramFiles');
const { log } = require('./utils/logger');

/**
 * The shared application module.
 *
 * Both entry points build on this: api/telegram-webhook.js in production and
 * src/dev-polling.js locally. Neither contains routing logic of its own, so the
 * two environments cannot drift apart.
 *
 * The critical difference from the original src/index.js is that dispatch is
 * AWAITABLE. The old code registered bot.on('message', ...) listeners, and an
 * EventEmitter discards whatever its listeners return - so processUpdate() came
 * back immediately while handlers were still running. On a long-running server
 * that was invisible; on Vercel the function would be frozen mid-handler and
 * the work silently lost.
 */

let bot = null;

function getBot() {
  if (bot) {
    return bot;
  }

  assertRequiredConfig(['telegram']);

  // polling:false everywhere. dev-polling.js starts polling explicitly.
  bot = new TelegramBot(config.telegram.botToken, { polling: false });

  instrumentSendMethods(bot);

  return bot;
}

/**
 * Preserves the original behaviour of recording the newest message id per chat,
 * which the admin menu uses to decide whether it can edit its message in place
 * or must repost to stay at the bottom of the conversation.
 *
 * Two changes from the original monkey patch: the id is persisted rather than
 * held in memory, and it is only recorded for ADMIN chats. Customers never see
 * the admin menu, so storing their message ids would be pure write traffic.
 *
 * If node-telegram-bot-api is ever upgraded, re-test admin menu positioning -
 * this patch depends on sendMessage/sendPhoto resolving to the sent Message.
 */
function instrumentSendMethods(botInstance) {
  const originalSendMessage = botInstance.sendMessage.bind(botInstance);
  const originalSendPhoto = botInstance.sendPhoto.bind(botInstance);

  const track = async sent => {
    try {
      if (sent && sent.chat && isAdmin(Number(sent.chat.id))) {
        await noteChatMessage(sent.chat.id, sent.message_id);
      }
    } catch (error) {
      // Menu positioning is cosmetic; never fail a send because of it.
      log('warn', 'note_chat_message_failed', { error: error.message });
    }
    return sent;
  };

  botInstance.sendMessage = async (...args) => track(await originalSendMessage(...args));
  botInstance.sendPhoto = async (...args) => track(await originalSendPhoto(...args));
}

// --- Dispatch ----------------------------------------------------------------

/**
 * Route one message. Dispatch order is unchanged from the original:
 * admin handlers first, then user handlers, then the fallback.
 */
async function dispatchMessage(botInstance, msg, deferred) {
  await noteChatMessageIfAdmin(msg);

  // Photos and image documents are usually payment receipts, unless the
  // sender is an admin attaching a photo to the preorder post, or relaying a
  // drop-off photo to a customer.
  if (msg.photo || isImageDocument(msg.document)) {
    if (await handleAdminPreorderPhoto(botInstance, msg)) {
      return;
    }

    if (await handleAdminDropoffPhoto(botInstance, msg)) {
      return;
    }

    const result = await handleUserPhoto(botInstance, msg);

    if (result) {
      // Verification is slow, so it is handed back to the caller to run after
      // the response rather than making Telegram wait for a Gemini round trip.
      if (result.submissionId) {
        deferred.push(() => verifySubmission(botInstance, result.submissionId));
      }
      return;
    }
  }

  if (await handleAdminCommand(botInstance, msg)) {
    return;
  }

  if (await handleUserCommand(botInstance, msg)) {
    return;
  }

  // Replaces the original `You said: ...` echo, which made an ordering bot look
  // broken when someone typed anything unrecognised.
  await sendFallbackHint(botInstance, msg);
}

/**
 * Required lazily: paymentVerifier pulls in the handlers, so importing it at
 * module scope would create a cycle with this file.
 */
async function verifySubmission(botInstance, submissionId) {
  const { processSubmission } = require('./services/paymentVerifier');
  const { config } = require('./config');

  await processSubmission(botInstance, submissionId, {
    deadline: Date.now() + config.worker.timeBudgetMs,
  });
}

async function dispatchCallback(botInstance, query) {
  if (await handleAdminCallback(botInstance, query)) {
    return;
  }

  await handleUserCallback(botInstance, query);
}

async function noteChatMessageIfAdmin(msg) {
  try {
    if (msg.chat && isAdmin(Number(msg.from && msg.from.id))) {
      await noteChatMessage(msg.chat.id, msg.message_id);
    }
  } catch (error) {
    log('warn', 'note_chat_message_failed', { error: error.message });
  }
}

/**
 * Handle one Telegram update to completion.
 *
 * The returned promise settles only once all handler work has finished, which
 * is what lets the webhook decide when it is safe to return 200.
 */
async function handleUpdate(update) {
  const botInstance = getBot();

  // Admin ids come from the Settings sheet and used to be loaded once at
  // startup. There is no reliable startup on serverless, so they are loaded on
  // demand and cached per warm instance.
  await ensureAdminIdsLoaded();

  // Slow follow-up work the caller should run after responding. The webhook
  // passes these to waitUntil; dev-polling simply awaits them.
  const deferred = [];

  if (update.message) {
    await dispatchMessage(botInstance, update.message, deferred);
  } else if (update.callback_query) {
    await dispatchCallback(botInstance, update.callback_query);
  } else {
    log('info', 'update_ignored', {
      update_id: update.update_id,
      kinds: Object.keys(update).filter(key => key !== 'update_id'),
    });
  }

  return { deferred };
}

/** Update kinds the bot actually uses, passed to setWebhook. */
const ALLOWED_UPDATES = ['message', 'callback_query'];

module.exports = {
  getBot,
  handleUpdate,
  dispatchMessage,
  dispatchCallback,
  noteChatMessage,
  isMessageLatestInChat,
  isImageDocument,
  ALLOWED_UPDATES,
};
