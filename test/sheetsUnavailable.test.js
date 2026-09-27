const test = require('node:test');
const assert = require('node:assert/strict');
const googleSheets = require('../src/services/googleSheets');
const stateStore = require('../src/services/stateStore');
const orderStore = require('../src/services/orderStore');
const cartStore = require('../src/services/cartStore');
const repo = require('../src/services/orderRepository');
const admin = require('../src/handlers/admin');
const { handleUserCommand, handleUserCallback } = require('../src/handlers/user');

/**
 * A failed Google Sheets read used to look exactly like an empty sheet: the
 * public post edited to "No food currently available", carts cleared as "the
 * menu changed", and "No halls available" on /start.
 */

function sheetsDown() {
  const error = new Error('Google Sheets read failed: socket hang up');
  error.code = 'SHEETS_UNAVAILABLE';
  return error;
}

test('the scheduled preorder refresh leaves the live post alone while Sheets is down', async t => {
  t.mock.method(stateStore, 'get', async (key, fallback = null) => (
    key === stateStore.KEYS.preorderPost() ? { channelId: 'chan1', msgId: 111, contentHash: 'h' } : fallback
  ));
  t.mock.method(googleSheets, 'getHallsOrThrow', async () => { throw sheetsDown(); });

  const bot = { async editMessageText() { throw new Error('must not edit the post'); } };

  assert.deepEqual(await admin.refreshPreorderPost(bot), { skipped: 'sheets_unavailable' });
});

test('/start while Sheets is down asks the customer to retry instead of "No halls available"', async t => {
  t.mock.method(cartStore, 'clearCart', async () => {});
  t.mock.method(stateStore, 'get', async (key, fallback = null) => (
    key === stateStore.KEYS.preorderPost() ? { channelId: 'chan1', msgId: 111 } : fallback
  ));
  t.mock.method(orderStore, 'loadBlockedHalls', async () => ({ isBlocked: () => false }));
  t.mock.method(googleSheets, 'getHallsOrThrow', async () => { throw sheetsDown(); });

  const sent = [];
  const bot = { async sendMessage(chatId, text) { sent.push(text); } };

  await handleUserCommand(bot, { chat: { id: 555 }, from: { id: 777 }, text: '/start' });

  assert.equal(sent.length, 1);
  assert.match(sent[0], /temporary problem/);
  assert.doesNotMatch(sent[0], /No halls/);
});

test('confirming an order while Sheets is down keeps the cart', async t => {
  t.mock.method(repo, 'getCustomerByTelegramId', async () => ({ id: 'c1', phone_number: '91234567' }));
  t.mock.method(stateStore, 'withLock', async (name, task) => task());
  t.mock.method(stateStore, 'get', async (key, fallback = null) => (
    key === stateStore.KEYS.preorderPost() ? { channelId: 'chan1', msgId: 111 } : fallback
  ));
  t.mock.method(cartStore, 'getCart', async () => ({
    hallSheetRowId: 2, hallName: 'Hall A', items: { 3: { quantity: 1, name: 'Chicken Rice' } },
  }));
  t.mock.method(orderStore, 'loadBlockedHalls', async () => ({ isBlocked: () => false }));
  t.mock.method(googleSheets, 'getFoodItemsOrThrow', async () => { throw sheetsDown(); });
  t.mock.method(cartStore, 'clearItems', async () => { throw new Error('must not clear the cart'); });
  t.mock.method(cartStore, 'clearCart', async () => { throw new Error('must not clear the cart'); });

  const answers = [];
  const bot = {
    async answerCallbackQuery(id, opts) { answers.push(opts.text); },
    async sendMessage() {},
  };

  await handleUserCallback(bot, {
    id: 'q1', data: 'user_confirm_order', from: { id: 777 }, message: { chat: { id: 555 }, message_id: 9 },
  });

  assert.match(answers[0], /cart is still saved/);
});

test('a real bug is still thrown, not disguised as a Sheets outage', async t => {
  t.mock.method(cartStore, 'clearCart', async () => { throw new Error('database exploded'); });

  const bot = { async sendMessage() {} };

  await assert.rejects(
    handleUserCommand(bot, { chat: { id: 555 }, from: { id: 777 }, text: '/start' }),
    /database exploded/
  );
});
