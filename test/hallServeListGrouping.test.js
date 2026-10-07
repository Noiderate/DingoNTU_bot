const test = require('node:test');
const assert = require('node:assert/strict');

const admin = require('../src/handlers/admin');
const orderStore = require('../src/services/orderStore');
const cartStore = require('../src/services/cartStore');
const orderActions = require('../src/services/orderActions');
const stateStore = require('../src/services/stateStore');
const googleSheets = require('../src/services/googleSheets');

/**
 * The "we are here" serve list groups by customer (phone number) instead of
 * one row per order, and drills into a per-order Served/Dropped off submenu.
 * See admin.js's buildHallCustomerListKeyboard / handleServeCustomerOpen /
 * handleServeMarkOrder.
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
    ...overrides,
  };
}


// --- grouping / sorting / formatting -----------------------------------------

test('groupOrdersByCustomer combines a customer\'s multiple orders into one entry', () => {
  const groups = admin.groupOrdersByCustomer([
    makeOrder({ id: 'o1', code: 'DG1' }),
    makeOrder({ id: 'o2', code: 'DG2' }),
    makeOrder({ id: 'o3', code: 'DG3', userId: 2, phoneNumber: '98887777' }),
  ]);

  assert.equal(groups.length, 2);
  const ali = groups.find(g => g.telegramUserId === 1);
  assert.equal(ali.orders.length, 2);
  assert.deepEqual(ali.orders.map(o => o.code), ['DG1', 'DG2']);
});

test('sortCustomerGroups orders by phone number, customers with no phone last', () => {
  const groups = [
    { telegramUserId: 1, phone: '98887777', handle: '@bee' },
    { telegramUserId: 2, phone: '91112222', handle: '@ali' },
    { telegramUserId: 3, phone: null, handle: '@zara' },
    { telegramUserId: 4, phone: null, handle: '@amy' },
  ];

  const sorted = admin.sortCustomerGroups(groups);

  assert.deepEqual(sorted.map(g => g.telegramUserId), [2, 1, 4, 3]);
});

test('formatCustomerListButtonText shows the phone number followed by the food ordered', () => {
  const group = { phone: '91112222', handle: '@ali', orders: [makeOrder()] };
  const text = admin.formatCustomerListButtonText(group);

  assert.match(text, /^91112222/);
  assert.match(text, /Chicken Rice x1/);
});

test('formatCustomerListButtonText falls back to the handle when there is no phone on file', () => {
  const group = { phone: null, handle: '@ali', orders: [makeOrder()] };
  const text = admin.formatCustomerListButtonText(group);

  assert.match(text, /no phone on file/i);
  assert.match(text, /@ali/);
});

test('formatCustomerListButtonText combines items across multiple orders for one customer', () => {
  const group = {
    phone: '91112222',
    handle: '@ali',
    orders: [
      makeOrder({ items: [{ name: 'Chicken Rice', quantity: 1 }] }),
      makeOrder({ items: [{ name: 'Iced Milo', quantity: 2 }] }),
    ],
  };

  const text = admin.formatCustomerListButtonText(group);

  assert.match(text, /Chicken Rice x1/);
  assert.match(text, /Iced Milo x2/);
});

test('encodeCustomerKey / decodeCustomerKey round-trip, splitting on the LAST separator', () => {
  // A hall name could in principle contain the separator; the telegram id
  // never does, so decoding must anchor on the last occurrence.
  const encoded = admin.encodeCustomerKey('Hall | Weird Name', 123456789);
  assert.deepEqual(admin.decodeCustomerKey(encoded), { hallName: 'Hall | Weird Name', telegramUserId: 123456789 });
});

test('buildHallCustomerListKeyboard is one button per customer, not per order, plus a remaining-items row', () => {
  const keyboard = admin.buildHallCustomerListKeyboard('Hall A', [
    makeOrder({ id: 'o1', code: 'DG1' }),
    makeOrder({ id: 'o2', code: 'DG2' }), // same customer as o1
    makeOrder({ id: 'o3', code: 'DG3', userId: 2, phoneNumber: '98887777' }),
  ]);

  // 2 customers + the "Drop Remaining Items Off" row.
  assert.equal(keyboard.inline_keyboard.length, 3);
  assert.equal(keyboard.inline_keyboard[0].length, 1); // one button per row - full width
  assert.match(keyboard.inline_keyboard[2][0].text, /Drop Remaining Items Off/);
});


// --- submenu -------------------------------------------------------------------

test('buildCustomerSubmenuText shows the handle, phone, and each order', () => {
  const group = { handle: '@ali', phone: '91112222', orders: [makeOrder(), makeOrder({ id: 'o2', code: 'DG2' })] };
  const text = admin.buildCustomerSubmenuText(group);

  assert.match(text, /@ali/);
  assert.match(text, /91112222/);
  assert.match(text, /DG1/);
  assert.match(text, /DG2/);
});

test('buildCustomerSubmenuKeyboard: a single order gets plain Served/Dropped off buttons', () => {
  const group = { handle: '@ali', phone: '91112222', orders: [makeOrder()] };
  const keyboard = admin.buildCustomerSubmenuKeyboard('Hall A', group);

  // One row per order (2 buttons) + one Back row.
  assert.equal(keyboard.inline_keyboard.length, 2);
  assert.equal(keyboard.inline_keyboard[0][0].text, '✅ Served');
  assert.equal(keyboard.inline_keyboard[0][1].text, '📦 Dropped off');
  assert.match(keyboard.inline_keyboard[1][0].text, /Back/);
});

test('buildCustomerSubmenuKeyboard: multiple orders label each button with its order code', () => {
  const group = { handle: '@ali', phone: '91112222', orders: [makeOrder({ code: 'DG1' }), makeOrder({ id: 'o2', code: 'DG2' })] };
  const keyboard = admin.buildCustomerSubmenuKeyboard('Hall A', group);

  assert.equal(keyboard.inline_keyboard.length, 3); // 2 order rows + Back
  assert.match(keyboard.inline_keyboard[0][0].text, /DG1/);
  assert.match(keyboard.inline_keyboard[1][0].text, /DG2/);
});


// --- handlers --------------------------------------------------------------

test('handleServeCustomerOpen shows the tapped customer\'s submenu', async t => {
  t.mock.method(stateStore, 'get', async (key, fallback = null) => fallback); // cache miss
  t.mock.method(stateStore, 'set', async () => {});
  t.mock.method(orderStore, 'getActiveOrdersByHall', async () => [makeOrder()]);

  const edits = [];
  const bot = {
    async editMessageText(text, opts) { edits.push({ text, opts }); },
    async answerCallbackQuery() {},
  };

  const data = `dmsc_${admin.encodeCustomerKey('Hall A', 1)}`;
  const query = { id: 'q1', message: { chat: { id: 555 } } };
  await admin.handleServeCustomerOpen(bot, query, 555, 999, data);

  assert.equal(edits.length, 1);
  assert.match(edits[0].text, /Chicken Rice/);
  assert.equal(edits[0].opts.reply_markup.inline_keyboard.length, 2); // 1 order row + Back
});

test('handleServeCustomerOpen falls back to the list when the customer has nothing left (stale tap)', async t => {
  t.mock.method(stateStore, 'get', async (key, fallback = null) => fallback);
  t.mock.method(stateStore, 'set', async () => {});
  t.mock.method(orderStore, 'getActiveOrdersByHall', async () => []); // already all resolved

  const edits = [];
  const toasts = [];
  const bot = {
    async editMessageText(text, opts) { edits.push({ text, opts }); },
    async answerCallbackQuery(id, opts) { toasts.push(opts); },
  };

  const data = `dmsc_${admin.encodeCustomerKey('Hall A', 1)}`;
  await admin.handleServeCustomerOpen(bot, { id: 'q1', message: { chat: { id: 555 } } }, 555, 999, data);

  assert.equal(edits.length, 1);
  assert.match(edits[0].text, /we are here/);
  assert.match(toasts[0].text, /no orders left/i);
});

test('handleServeMarkOrder: dropped off only asks for a photo and does not mark the order yet', async t => {
  const marked = [];
  const pending = [];
  t.mock.method(orderStore, 'markOrderServed', async (...args) => { marked.push(args); return null; });
  t.mock.method(orderStore, 'getPendingOrder', async () => makeOrder({ id: 'order-2', code: 'DG2' }));
  t.mock.method(stateStore, 'set', async (key, value) => { pending.push({ key, value }); });

  const sent = [];
  const bot = {
    async sendMessage(chatId, text) { sent.push({ chatId, text }); },
    async answerCallbackQuery() {},
  };

  await admin.handleServeMarkOrder(bot, { id: 'q2', from: { id: 9 }, message: { chat: { id: 555 } } }, 555, 999, 'dmsd_order-2', 'dropped_off');

  assert.equal(marked.length, 0);
  assert.equal(pending.length, 1);
  assert.deepEqual(pending[0].value.orderIds, ['order-2']);
  assert.equal(pending[0].value.customerChatId, 1);
  assert.match(sent[0].text, /Send a photo/i);
});

test('handleServeMarkOrder: served sends the "handed to you" message', async t => {
  t.mock.method(orderStore, 'markOrderServed', async (orderId, adminId, opts) => ({
    id: orderId, code: 'DG1', chatId: 1, userId: 1, hallName: 'Hall A', wasUnpaid: false, kind: opts.kind,
  }));
  t.mock.method(orderStore, 'getActiveOrdersByHall', async () => []); // this customer's last order just cleared
  t.mock.method(stateStore, 'set', async () => {});
  t.mock.method(stateStore, 'get', async (key, fallback = null) => fallback);
  t.mock.method(stateStore, 'remove', async () => {});
  t.mock.method(googleSheets, 'getPreorderAdminTag', async () => null);
  t.mock.method(googleSheets, 'getHalls', async () => []); // autoAdvanceDeliveryStage's lookup

  const sent = [];
  const bot = {
    async sendMessage(chatId, text) { sent.push({ chatId, text }); },
    async editMessageText() {},
    async answerCallbackQuery() {},
  };

  await admin.handleServeMarkOrder(bot, { id: 'q1', from: { id: 9 }, message: { chat: { id: 555 } } }, 555, 999, 'dmss_order-1', 'served');
  assert.match(sent[0].text, /handed to you/i);
});

test('handleServeMarkOrder returns to the customer submenu when they still have other orders left', async t => {
  t.mock.method(orderStore, 'markOrderServed', async () => ({
    id: 'o1', code: 'DG1', chatId: 1, userId: 1, hallName: 'Hall A', wasUnpaid: false, kind: 'served',
  }));
  // One order for this customer remains active after the one just marked.
  t.mock.method(orderStore, 'getActiveOrdersByHall', async () => [makeOrder({ id: 'o2', code: 'DG2' })]);
  t.mock.method(stateStore, 'set', async () => {});
  t.mock.method(stateStore, 'get', async (key, fallback = null) => fallback);
  t.mock.method(googleSheets, 'getPreorderAdminTag', async () => null);
  t.mock.method(googleSheets, 'getHalls', async () => []); // autoAdvanceDeliveryStage's lookup

  const edits = [];
  const bot = {
    async sendMessage() {},
    async editMessageText(text, opts) { edits.push({ text, opts }); },
    async answerCallbackQuery() {},
  };

  await admin.handleServeMarkOrder(bot, { id: 'q1', from: { id: 9 }, message: { chat: { id: 555 } } }, 555, 999, 'dmss_o1', 'served');

  assert.equal(edits.length, 1);
  assert.match(edits[0].text, /DG2/); // back in the submenu, not the top-level list
});
