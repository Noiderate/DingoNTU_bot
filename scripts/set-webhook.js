#!/usr/bin/env node
const { config, assertRequiredConfig } = require('../src/config');
const { ALLOWED_UPDATES } = require('../src/app');

/**
 * Register, inspect or remove the Telegram webhook.
 *
 *   npm run webhook:set     [-- --drop-pending]
 *   npm run webhook:info
 *   npm run webhook:delete
 *
 * Remember a token can only do ONE of polling or webhook at a time. Use a
 * separate test bot for local development and preview deployments so setting a
 * webhook here can never take production offline.
 */

const API = token => `https://api.telegram.org/bot${token}`;

async function call(method, body) {
  const response = await fetch(`${API(config.telegram.botToken)}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });

  const payload = await response.json();

  if (!payload.ok) {
    throw new Error(`${method} failed: ${payload.description || response.status}`);
  }

  return payload.result;
}

async function set(dropPending) {
  assertRequiredConfig(['telegram', 'webhook']);

  if (!config.telegram.publicBaseUrl) {
    throw new Error('PUBLIC_BASE_URL is not set. Example: https://your-project.vercel.app');
  }

  const url = `${config.telegram.publicBaseUrl}/api/telegram-webhook`;

  const result = await call('setWebhook', {
    url,
    secret_token: config.telegram.webhookSecret,
    // Only the update kinds the bot actually handles, so Telegram does not send
    // traffic we would only discard.
    allowed_updates: ALLOWED_UPDATES,
    drop_pending_updates: Boolean(dropPending),
  });

  console.log(`Webhook set to ${url}`);
  console.log(`Allowed updates: ${ALLOWED_UPDATES.join(', ')}`);

  if (dropPending) {
    console.log('Pending updates dropped.');
  }

  return result;
}

async function info() {
  const result = await call('getWebhookInfo');

  console.log('Webhook URL            :', result.url || '(none - polling mode)');
  console.log('Pending updates        :', result.pending_update_count);
  console.log('Max connections        :', result.max_connections ?? '(default)');
  console.log('Allowed updates        :', (result.allowed_updates || []).join(', ') || '(all)');
  console.log('Custom certificate     :', result.has_custom_certificate);
  console.log('Last error message     :', result.last_error_message || '(none)');

  if (result.last_error_date) {
    console.log('Last error at          :', new Date(result.last_error_date * 1000).toISOString());
  }

  if (result.pending_update_count > 0) {
    console.log(
      '\nA non-zero pending count means Telegram is holding updates it could not\n'
      + 'deliver. Common causes: the deployment is down, the URL is wrong after a\n'
      + 'domain change, the secret does not match, or Vercel Deployment Protection\n'
      + 'is blocking Telegram from reaching a preview URL.'
    );
  }

  return result;
}

async function remove() {
  await call('deleteWebhook', { drop_pending_updates: false });
  console.log('Webhook deleted. You can now use long polling locally (npm run dev).');
}

async function main() {
  const [command, ...flags] = process.argv.slice(2);

  switch (command) {
    case 'set':
      await set(flags.includes('--drop-pending'));
      break;
    case 'info':
      await info();
      break;
    case 'delete':
      await remove();
      break;
    default:
      console.error('Usage: node scripts/set-webhook.js <set|info|delete> [--drop-pending]');
      process.exit(1);
  }
}

main().catch(error => {
  console.error('Error:', error.message);
  process.exit(1);
});
