const test = require('node:test');
const assert = require('node:assert/strict');
const repo = require('../src/services/orderRepository');
const orderStore = require('../src/services/orderStore');
const googleSheets = require('../src/services/googleSheets');
const { handleUserPhoto } = require('../src/handlers/user');

/**
 * A screenshot sent when nothing is awaiting payment - most often because
 * the order expired moments earlier - used to be silently ignored.
 */

const { STATUS } = repo;

const PHOTO_MSG = {
  message_id: 10,
  chat: { id: 555 },
  from: { id: 777 },
  photo: [{ file_id: 'small', file_unique_id: 's' }, { file_id: 'large', file_unique_id: 'l' }],
};

function orderRow(status, extra = {}) {
  return {
    id: 'o1', order_code: 'DG7', status, telegram_chat_id: 555, total_cents: 500,
    order_items: [], customers: { telegram_user_id: 777, telegram_username: 'bee' }, ...extra,
  };
}

function captureBot() {
  const messages = [];
  const photos = [];
  return {
    messages,
    photos,
    async sendMessage(chatId, text) { messages.push({ chatId, text }); return { message_id: 1 }; },
    async sendPhoto(chatId, fileId, opts) { photos.push({ chatId, fileId, opts }); },
  };
}

test('a screenshot for an order that just expired gets the expiry explanation again', async t => {
  t.mock.method(orderStore, 'getAwaitingPaymentOrder', async () => null);
  t.mock.method(repo, 'getOrdersForCustomer', async () => ({ orders: [orderRow(STATUS.EXPIRED)], total: 1 }));

  const bot = captureBot();
  const handled = await handleUserPhoto(bot, PHOTO_MSG);

  assert.equal(handled, true);
  assert.equal(bot.messages.length, 1);
  assert.match(bot.messages[0].text, /DG7 expired/);
  assert.match(bot.messages[0].text, /no need to pay again/i);
});

test('a screenshot for an already-paid order says nothing more is needed', async t => {
  t.mock.method(orderStore, 'getAwaitingPaymentOrder', async () => null);
  t.mock.method(repo, 'getOrdersForCustomer', async () => ({ orders: [orderRow(STATUS.PAID)], total: 1 }));

  const bot = captureBot();
  await handleUserPhoto(bot, PHOTO_MSG);

  assert.match(bot.messages[0].text, /already confirmed/);
});

test('a screenshot for an order served before payment is forwarded to admins with Mark Paid', async t => {
  t.mock.method(orderStore, 'getAwaitingPaymentOrder', async () => null);
  t.mock.method(repo, 'getOrdersForCustomer', async () => (
    { orders: [orderRow(STATUS.SERVED, { paid_at: null })], total: 1 }
  ));
  t.mock.method(googleSheets, 'getAdminIds', () => [42, 43]);

  const bot = captureBot();
  await handleUserPhoto(bot, PHOTO_MSG);

  assert.match(bot.messages[0].text, /admin will confirm/i);
  assert.deepEqual(bot.photos.map(photo => photo.chatId), [42, 43]);
  for (const photo of bot.photos) {
    assert.equal(photo.fileId, 'large');
    assert.match(photo.opts.reply_markup.inline_keyboard[0][0].callback_data, /^payment_accept_o1$/);
  }
});

test('a non-image message with no payable order is left unhandled', async t => {
  t.mock.method(orderStore, 'getAwaitingPaymentOrder', async () => null);
  t.mock.method(repo, 'getOrdersForCustomer', async () => {
    throw new Error('should not look up orders for a non-image');
  });

  const bot = captureBot();
  const handled = await handleUserPhoto(bot, { ...PHOTO_MSG, photo: undefined, document: { mime_type: 'application/pdf' } });

  assert.equal(handled, false);
  assert.equal(bot.messages.length, 0);
});
