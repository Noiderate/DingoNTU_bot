const TelegramBot = require('node-telegram-bot-api');
require('dotenv').config();
const { initializeGoogleSheets } = require('./services/googleSheets');
const { handleAdminCommand, handleAdminCallback } = require('./handlers/admin');
const { handleUserCommand, echoMessage, handleUserCallback, handleUserPhoto } = require('./handlers/user');
const { noteChatMessage } = require('./handlers/deliveryMode');

// Initialize Telegram bot
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });

const originalSendMessage = bot.sendMessage.bind(bot);
bot.sendMessage = async (...args) => {
  const sentMessage = await originalSendMessage(...args);
  noteChatMessage(sentMessage.chat.id, sentMessage.message_id);
  return sentMessage;
};

const originalSendPhoto = bot.sendPhoto.bind(bot);
bot.sendPhoto = async (...args) => {
  const sentMessage = await originalSendPhoto(...args);
  noteChatMessage(sentMessage.chat.id, sentMessage.message_id);
  return sentMessage;
};

// Initialize bot on startup
(async () => {
  const sheetsReady = await initializeGoogleSheets();
  if (!sheetsReady) {
    console.warn('⚠ Google Sheets not available. Bot will work in basic mode.');
  }
  console.log('Bot is running...');
})();

// Message handler router
bot.on('message', async (msg) => {
  try {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const userMessage = msg.text;

    noteChatMessage(chatId, msg.message_id);

    // Handle payment screenshot photos
    if (msg.photo) {
      await handleUserPhoto(bot, msg);
      return;
    }

    console.log(`Received message: "${userMessage}" from ${msg.from.first_name} (ID: ${userId})`);

    // Try admin commands first
    if (await handleAdminCommand(bot, msg)) {
      return;
    }

    // Try user commands
    if (await handleUserCommand(bot, msg)) {
      return;
    }

    // Default: echo the message
    await echoMessage(bot, msg);
  } catch (error) {
    console.error('Unhandled message handler error:', error.stack || error.message);
  }
});

// Callback query handler for button clicks
bot.on('callback_query', async (query) => {
  try {
    console.log(`Callback query: ${query.data} from user ${query.from.id}`);

    // Try admin callbacks
    if (await handleAdminCallback(bot, query)) {
      return;
    }

    // Try user callbacks
    if (await handleUserCallback(bot, query)) {
      return;
    }
  } catch (error) {
    console.error('Unhandled callback query error:', error.stack || error.message);
  }
});