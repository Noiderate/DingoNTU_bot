const test = require('node:test');
const assert = require('node:assert/strict');
const stateStore = require('../src/services/stateStore');
const orderStore = require('../src/services/orderStore');
const {
  recordHallServeMessage,
  getHallServeMessage,
  clearHallServeMessage,
} = require('../src/handlers/deliveryMode');
const { refreshHallServeOrdersMessage } = require('../src/handlers/admin');

/**
 * A new order placed for a hall after "we are here" has already been posted
 * must be added to that already-sent "Tap each order when served" message,
 * rather than only ever reflecting the snapshot taken when it was first sent.
 */

test('recordHallServeMessage / getHallServeMessage / clearHallServeMessage round-trip through stateStore', async t => {
  const store = new Map();
  t.mock.method(stateStore, 'set', async (key, value) => { store.set(key, value); return value; });
  t.mock.method(stateStore, 'get', async (key, fallback = null) => (store.has(key) ? store.get(key) : fallback));
  t.mock.method(stateStore, 'remove', async key => { store.delete(key); });

  assert.equal(await getHallServeMessage('Hall 12'), null);

  await recordHallServeMessage('Hall 12', 555, 999);
  assert.deepEqual(await getHallServeMessage('Hall 12'), { chatId: 555, messageId: 999 });

  await clearHallServeMessage('Hall 12');
  assert.equal(await getHallServeMessage('Hall 12'), null);
});

test('refreshHallServeOrdersMessage does nothing when no serve message is tracked for the hall', async t => {
  t.mock.method(stateStore, 'get', async (key, fallback = null) => fallback);
  t.mock.method(orderStore, 'getActiveOrdersByHall', async () => {
    throw new Error('should not fetch orders when nothing is tracked');
  });

  let edited = false;
  const bot = { async editMessageReplyMarkup() { edited = true; } };

  await refreshHallServeOrdersMessage(bot, 'Hall 12');
  assert.equal(edited, false);
});

test("refreshHallServeOrdersMessage adds a newly placed order's button to the tracked message", async t => {
  t.mock.method(stateStore, 'get', async () => ({ chatId: 555, messageId: 999 }));
  t.mock.method(orderStore, 'getActiveOrdersByHall', async hallName => {
    assert.equal(hallName, 'Hall 12');
    return [
      { id: 'order-1', code: 'DG1', totalCents: 500, userName: 'Ali', username: null },
      { id: 'order-2', code: 'DG2', totalCents: 300, userName: 'Bee', username: null },
    ];
  });

  const calls = [];
  const bot = { async editMessageReplyMarkup(markup, opts) { calls.push({ markup, opts }); } };

  await refreshHallServeOrdersMessage(bot, 'Hall 12');

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].opts, { chat_id: 555, message_id: 999 });
  assert.equal(calls[0].markup.inline_keyboard.length, 2);
  assert.match(calls[0].markup.inline_keyboard[1][0].text, /DG2/);
});

test('refreshHallServeOrdersMessage clears the tracked ref once the hall has no active orders left', async t => {
  t.mock.method(stateStore, 'get', async () => ({ chatId: 555, messageId: 999 }));
  t.mock.method(orderStore, 'getActiveOrdersByHall', async () => []);

  const removed = [];
  t.mock.method(stateStore, 'remove', async key => removed.push(key));

  let edited = false;
  const bot = { async editMessageReplyMarkup() { edited = true; } };

  await refreshHallServeOrdersMessage(bot, 'Hall 12');

  assert.equal(edited, false);
  assert.equal(removed.length, 1);
});

test('refreshHallServeOrdersMessage swallows a benign "message is not modified" edit error', async t => {
  t.mock.method(stateStore, 'get', async () => ({ chatId: 555, messageId: 999 }));
  t.mock.method(orderStore, 'getActiveOrdersByHall', async () => [
    { id: 'order-1', code: 'DG1', totalCents: 500, userName: 'Ali', username: null },
  ]);

  const bot = {
    async editMessageReplyMarkup() { throw new Error('Bad Request: message is not modified'); },
  };

  await assert.doesNotReject(refreshHallServeOrdersMessage(bot, 'Hall 12'));
});
