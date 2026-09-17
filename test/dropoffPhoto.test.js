const test = require('node:test');
const assert = require('node:assert/strict');

const admin = require('../src/handlers/admin');
const orderStore = require('../src/services/orderStore');
const stateStore = require('../src/services/stateStore');
const googleSheets = require('../src/services/googleSheets');

/**
 * "Drop Remaining Items Off": a collated per-item summary of everything still
 * uncollected at a hall, and a phone|handle list that starts a photo relay -
 * the admin sends the bot a photo, the bot forwards it to the customer, and
 * marks every order it covers dropped off. See admin.js: collateRemainingItems,
 * handleServeRemainingOpen, handleServeDropoffStart, handleAdminDropoffPhoto.
 */

function makeOrder(overrides = {}) {
  return {
    id: 'order-1',
    code: 'DG1',
    userId: 1,
    phoneNumber: '91112222',
    userName: 'Ali',
    username: null,
    hallName: 'Hall A',
    chatId: 1,
    items: [{ name: 'Chicken Rice', quantity: 1 }],
    totalCents: 500,
    status: 'paid',
    ...overrides,
  };
}


// --- collateRemainingItems / text / keyboard -----------------------------------

test('collateRemainingItems sums quantities across every order, highest first', () => {
  const totals = admin.collateRemainingItems([
    makeOrder({ items: [{ name: 'Mala', quantity: 6 }] }),
    makeOrder({ id: 'o2', items: [{ name: 'Mala', quantity: 4 }, { name: 'Chicken', quantity: 5 }] }),
  ]);

  assert.deepEqual(totals, [['Mala', 10], ['Chicken', 5]]);
});

test('collateRemainingItems ties break alphabetically', () => {
  const totals = admin.collateRemainingItems([
    makeOrder({ items: [{ name: 'Zebra Cake', quantity: 2 }] }),
    makeOrder({ id: 'o2', items: [{ name: 'Apple Pie', quantity: 2 }] }),
  ]);

  assert.deepEqual(totals, [['Apple Pie', 2], ['Zebra Cake', 2]]);
});

test('buildRemainingItemsText lists collated totals for staff to leave behind', () => {
  const text = admin.buildRemainingItemsText('Hall A', [
    makeOrder({ items: [{ name: 'Mala', quantity: 10 }] }),
  ]);

  assert.match(text, /Mala x10/);
  assert.match(text, /Hall A/);
});

test('buildRemainingItemsText says so when nothing is left', () => {
  const text = admin.buildRemainingItemsText('Hall A', []);
  assert.match(text, /Nothing left to drop off/);
});

test('buildRemainingItemsKeyboard shows phone | handle, one row per customer, plus Back', () => {
  const keyboard = admin.buildRemainingItemsKeyboard('Hall A', [
    makeOrder({ userId: 1, phoneNumber: '91112222', username: 'ali' }),
    makeOrder({ id: 'o2', userId: 2, phoneNumber: '98887777', username: 'bee' }),
  ]);

  assert.equal(keyboard.inline_keyboard.length, 3); // 2 customers + Back
  assert.equal(keyboard.inline_keyboard[0][0].text, '91112222 | @ali');
  assert.equal(keyboard.inline_keyboard[1][0].text, '98887777 | @bee');
  assert.match(keyboard.inline_keyboard[2][0].text, /Back/);
});


// --- handleServeRemainingOpen / handleServeDropoffStart -------------------------

test('handleServeRemainingOpen shows the collated totals and the phone|handle list', async t => {
  t.mock.method(stateStore, 'get', async (key, fallback = null) => fallback); // cache miss -> fresh query
  t.mock.method(stateStore, 'set', async () => {});
  t.mock.method(orderStore, 'getActiveOrdersByHall', async () => [
    makeOrder({ items: [{ name: 'Mala', quantity: 3 }] }),
  ]);

  const edits = [];
  const bot = {
    async editMessageText(text, opts) { edits.push({ text, opts }); },
    async answerCallbackQuery() {},
  };

  await admin.handleServeRemainingOpen(bot, { id: 'q1', message: { chat: { id: 555 } } }, 555, 999, 'dmsr_Hall A');

  assert.equal(edits.length, 1);
  assert.match(edits[0].text, /Mala x3/);
});

test('handleServeDropoffStart records the pending relay and prompts for a photo', async t => {
  t.mock.method(stateStore, 'get', async (key, fallback = null) => fallback);
  const stored = {};
  t.mock.method(stateStore, 'set', async (key, value) => { stored[key] = value; });
  t.mock.method(orderStore, 'getActiveOrdersByHall', async () => [makeOrder()]);

  const sent = [];
  const bot = {
    async sendMessage(chatId, text) { sent.push({ chatId, text }); },
    async answerCallbackQuery() {},
  };

  const data = `dmsp_${admin.encodeCustomerKey('Hall A', 1)}`;
  await admin.handleServeDropoffStart(bot, { id: 'q1', from: { id: 42 }, message: { chat: { id: 555 } } }, 555, 999, data);

  const key = stateStore.KEYS.awaitingDropoffPhoto(42);
  assert.deepEqual(stored[key], {
    hallName: 'Hall A',
    telegramUserId: 1,
    customerChatId: 1,
    orderIds: ['order-1'],
  });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].chatId, 555);
  assert.match(sent[0].text, /Chicken Rice x1/);
});

test('handleServeDropoffStart falls back to the remaining-items list for a stale tap', async t => {
  t.mock.method(stateStore, 'get', async (key, fallback = null) => fallback);
  t.mock.method(stateStore, 'set', async () => {});
  t.mock.method(orderStore, 'getActiveOrdersByHall', async () => []); // already resolved

  const edits = [];
  const toasts = [];
  const bot = {
    async editMessageText(text, opts) { edits.push({ text, opts }); },
    async answerCallbackQuery(id, opts) { toasts.push(opts); },
  };

  const data = `dmsp_${admin.encodeCustomerKey('Hall A', 1)}`;
  await admin.handleServeDropoffStart(bot, { id: 'q1', from: { id: 42 }, message: { chat: { id: 555 } } }, 555, 999, data);

  assert.equal(edits.length, 1);
  assert.match(edits[0].text, /Nothing left to drop off/);
  assert.match(toasts[0].text, /no orders left/i);
});


// --- handleAdminDropoffPhoto -----------------------------------------------------

test('handleAdminDropoffPhoto does nothing when the sender has no pending drop-off', async t => {
  t.mock.method(stateStore, 'get', async (key, fallback = null) => fallback);

  const bot = { async sendPhoto() { throw new Error('should not be called'); } };
  const handled = await admin.handleAdminDropoffPhoto(bot, {
    from: { id: 42 }, chat: { id: 555 }, message_id: 1, photo: [{ file_id: 'f1' }],
  });

  assert.equal(handled, false);
});

test('handleAdminDropoffPhoto leaves a pending relay alone if the message is not an image', async t => {
  t.mock.method(stateStore, 'get', async () => ({ hallName: 'Hall A', telegramUserId: 1, customerChatId: 1, orderIds: ['o1'] }));

  const bot = { async sendPhoto() { throw new Error('should not be called'); } };
  const handled = await admin.handleAdminDropoffPhoto(bot, { from: { id: 42 }, chat: { id: 555 }, message_id: 1, text: 'hello' });

  assert.equal(handled, false);
});

test('handleAdminDropoffPhoto relays the photo, deletes it from the admin chat, and marks every order dropped off', async t => {
  const pendingKey = stateStore.KEYS.awaitingDropoffPhoto(42);
  t.mock.method(stateStore, 'get', async (key, fallback = null) => (
    key === pendingKey
      ? { hallName: 'Hall A', telegramUserId: 1, customerChatId: 777, orderIds: ['o1', 'o2'] }
      : fallback // e.g. getHallServeMessage's lookup - nothing tracked, so its refresh is a no-op
  ));
  let removedKey = null;
  t.mock.method(stateStore, 'remove', async key => { removedKey = key; });

  const marked = [];
  t.mock.method(orderStore, 'markOrderServed', async (orderId, adminId, opts) => {
    marked.push({ orderId, adminId, kind: opts.kind });
    return { id: orderId, code: `DG-${orderId}`, hallName: 'Hall A', wasUnpaid: false, kind: opts.kind };
  });
  t.mock.method(googleSheets, 'getHalls', async () => []); // autoAdvanceDeliveryStage's lookup

  const sentPhotos = [];
  const sentMessages = [];
  const deleted = [];
  const bot = {
    async sendPhoto(chatId, fileId, opts) { sentPhotos.push({ chatId, fileId, opts }); },
    async sendMessage(chatId, text) { sentMessages.push({ chatId, text }); },
    async deleteMessage(chatId, messageId) { deleted.push({ chatId, messageId }); },
  };

  const handled = await admin.handleAdminDropoffPhoto(bot, {
    from: { id: 42 }, chat: { id: 555 }, message_id: 100, photo: [{ file_id: 'small' }, { file_id: 'large' }],
  });

  assert.equal(handled, true);
  assert.equal(sentPhotos.length, 1);
  assert.equal(sentPhotos[0].chatId, 777); // the customer's chat, not the admin's
  assert.equal(sentPhotos[0].fileId, 'large'); // the largest size
  assert.deepEqual(deleted, [{ chatId: 555, messageId: 100 }]);
  assert.equal(removedKey, stateStore.KEYS.awaitingDropoffPhoto(42));
  assert.equal(marked.length, 2);
  assert.ok(marked.every(m => m.kind === 'dropped_off'));
  assert.match(sentMessages[sentMessages.length - 1].text, /DG-o1.*DG-o2|DG-o2.*DG-o1/);
});

test('handleAdminDropoffPhoto reports an error and leaves state untouched when the relay send fails', async t => {
  const pendingKey = stateStore.KEYS.awaitingDropoffPhoto(42);
  t.mock.method(stateStore, 'get', async (key, fallback = null) => (
    key === pendingKey
      ? { hallName: 'Hall A', telegramUserId: 1, customerChatId: 777, orderIds: ['o1'] }
      : fallback
  ));
  t.mock.method(stateStore, 'remove', async () => { throw new Error('should not be called'); });
  t.mock.method(orderStore, 'markOrderServed', async () => { throw new Error('should not be called'); });

  const sentMessages = [];
  const bot = {
    async sendPhoto() { throw new Error('bot was blocked by this user'); },
    async sendMessage(chatId, text) { sentMessages.push({ chatId, text }); },
    async deleteMessage() { throw new Error('should not be called'); },
  };

  const handled = await admin.handleAdminDropoffPhoto(bot, {
    from: { id: 42 }, chat: { id: 555 }, message_id: 100, photo: [{ file_id: 'f1' }],
  });

  assert.equal(handled, true);
  assert.equal(sentMessages.length, 1);
  assert.match(sentMessages[0].text, /could not send/i);
});

test('handleAdminDropoffPhoto skips an order already resolved elsewhere, without failing the others', async t => {
  const pendingKey = stateStore.KEYS.awaitingDropoffPhoto(42);
  t.mock.method(stateStore, 'get', async (key, fallback = null) => (
    key === pendingKey
      ? { hallName: 'Hall A', telegramUserId: 1, customerChatId: 777, orderIds: ['o1', 'o2'] }
      : fallback
  ));
  t.mock.method(stateStore, 'remove', async () => {});
  t.mock.method(orderStore, 'markOrderServed', async orderId => (
    orderId === 'o1' ? null : { id: orderId, code: 'DG-o2', hallName: 'Hall A', wasUnpaid: false, kind: 'dropped_off' }
  ));
  t.mock.method(googleSheets, 'getHalls', async () => []);

  const sentMessages = [];
  const bot = {
    async sendPhoto() {},
    async sendMessage(chatId, text) { sentMessages.push({ chatId, text }); },
    async deleteMessage() {},
  };

  await admin.handleAdminDropoffPhoto(bot, { from: { id: 42 }, chat: { id: 555 }, message_id: 100, photo: [{ file_id: 'f1' }] });

  assert.match(sentMessages[sentMessages.length - 1].text, /DG-o2/);
  assert.doesNotMatch(sentMessages[sentMessages.length - 1].text, /o1/);
});
