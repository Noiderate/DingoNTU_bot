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
  const bot = { async editMessageText() { edited = true; } };

  await refreshHallServeOrdersMessage(bot, 'Hall 12');
  assert.equal(edited, false);
});

test("refreshHallServeOrdersMessage groups a newly placed order under its customer's phone number", async t => {
  t.mock.method(stateStore, 'get', async () => ({ chatId: 555, messageId: 999 }));
  t.mock.method(stateStore, 'set', async () => {}); // the serve-orders cache write
  t.mock.method(orderStore, 'getActiveOrdersByHall', async hallName => {
    assert.equal(hallName, 'Hall 12');
    return [
      { id: 'order-1', code: 'DG1', userId: 1, phoneNumber: '91112222', userName: 'Ali', username: null, items: [] },
      { id: 'order-2', code: 'DG2', userId: 2, phoneNumber: '98887777', userName: 'Bee', username: null, items: [] },
    ];
  });

  const calls = [];
  const bot = { async editMessageText(text, opts) { calls.push({ text, opts }); } };

  await refreshHallServeOrdersMessage(bot, 'Hall 12');

  assert.equal(calls.length, 1);
  assert.equal(calls[0].opts.chat_id, 555);
  assert.equal(calls[0].opts.message_id, 999);
  // Sorted by phone number: 91112222 before 98887777, plus the "Drop
  // Remaining Items Off" row.
  assert.equal(calls[0].opts.reply_markup.inline_keyboard.length, 3);
  assert.match(calls[0].opts.reply_markup.inline_keyboard[0][0].text, /91112222/);
  assert.match(calls[0].opts.reply_markup.inline_keyboard[1][0].text, /98887777/);
});

test('refreshHallServeOrdersMessage clears the tracked ref once the hall has no active orders left', async t => {
  t.mock.method(stateStore, 'get', async () => ({ chatId: 555, messageId: 999 }));
  t.mock.method(stateStore, 'set', async () => {});
  t.mock.method(orderStore, 'getActiveOrdersByHall', async () => []);

  const removed = [];
  t.mock.method(stateStore, 'remove', async key => removed.push(key));

  let edited = false;
  const bot = { async editMessageText() { edited = true; } };

  await refreshHallServeOrdersMessage(bot, 'Hall 12');

  assert.equal(edited, false);
  assert.equal(removed.length, 1);
});

test('refreshHallServeOrdersMessage swallows a benign "message is not modified" edit error', async t => {
  t.mock.method(stateStore, 'get', async () => ({ chatId: 555, messageId: 999 }));
  t.mock.method(stateStore, 'set', async () => {});
  t.mock.method(orderStore, 'getActiveOrdersByHall', async () => [
    { id: 'order-1', code: 'DG1', userId: 1, phoneNumber: '91112222', userName: 'Ali', username: null, items: [] },
  ]);

  const bot = {
    async editMessageText() { throw new Error('Bad Request: message is not modified'); },
  };

  await assert.doesNotReject(refreshHallServeOrdersMessage(bot, 'Hall 12'));
});
