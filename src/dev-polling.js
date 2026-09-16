const { getBot, handleUpdate } = require('./app');
const { config } = require('./config');
const { log } = require('./utils/logger');

/**
 * Local development entry point.
 *
 * Uses long polling so there is no need for a public URL or a tunnel, but runs
 * exactly the same src/app.js dispatch as production, so behaviour cannot drift
 * between the two.
 *
 * A bot token CANNOT use polling and a webhook at the same time. If a webhook
 * is registered for this token, Telegram delivers updates there and polling
 * here silently receives nothing - or fails with 409 Conflict. Run
 * `npm run webhook:delete` first, and ideally use a SEPARATE test bot so you
 * never point production's webhook away by accident.
 */

async function main() {
  if (config.isProduction) {
    console.error(
      'Refusing to start long polling with NODE_ENV=production.\n'
      + 'Production runs as a webhook on Vercel via api/telegram-webhook.js.'
    );
    process.exit(1);
  }

  const bot = getBot();

  // Fail loudly rather than sitting silently receiving nothing.
  const info = await bot.getWebHookInfo();

  if (info.url) {
    console.error(
      `\nA webhook is currently registered for this bot token:\n  ${info.url}\n\n`
      + 'Telegram will deliver updates there, not here. Run:\n'
      + '  npm run webhook:delete\n\n'
      + 'If that URL is your PRODUCTION deployment, stop: use a separate test\n'
      + 'bot token for local development instead of taking production offline.\n'
    );
    process.exit(1);
  }

  const me = await bot.getMe();
  console.log(`Polling as @${me.username} (${config.nodeEnv}). Press Ctrl+C to stop.`);

  bot.on('polling_error', error => {
    log('error', 'polling_error', { error: error.message });
  });

  // The polling loop calls processUpdate for each update. Replacing it routes
  // updates through the same awaitable dispatch the webhook uses, instead of
  // through the library's EventEmitter, which would discard handler promises
  // and turn any failure into an unhandled rejection.
  bot.processUpdate = update => handleUpdate(update)
    .then(async ({ deferred }) => {
      // Production defers these to waitUntil; locally we simply await them.
      for (const task of deferred) {
        await task();
      }
    })
    .catch(error => {
      log('error', 'dev_handle_update_failed', {
        update_id: update.update_id,
        error: error.message,
        stack: error.stack,
      });
    });

  await bot.startPolling();
}

main().catch(error => {
  console.error('Failed to start:', error.message);
  process.exit(1);
});
