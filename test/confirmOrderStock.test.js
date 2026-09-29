const test = require('node:test');
const assert = require('node:assert/strict');
const repo = require('../src/services/orderRepository');
const stateStore = require('../src/services/stateStore');
const orderStore = require('../src/services/orderStore');
const cartStore = require('../src/services/cartStore');
const menuStore = require('../src/services/menuStore');
const admin = require('../src/handlers/admin');
const user = require('../src/handlers/user');

/**
 * Confirming an order with the menu in the database. Stock is deducted by one
 * atomic database call, so nothing here can oversell - what these tests pin down
 * is what the customer is told and what is (and is not) created when a step
 * fails part-way.
 */

const USER_ID = 777;
const CHAT_ID = 555;

const CART = {
  hallSheetRowId: 2,
  hallName: 'Hall A',
  items: { 3: { quantity: 2, name: 'Chicken Rice' } },
};

const LIVE_ITEMS = [{ id: 3, name: 'Chicken Rice', price: 2.5, stock: 5 }];

function setup(t, { cart = CART, liveItems = LIVE_ITEMS } = {}) {
  const log = {
    locks: [],
    deductions: [],
    restores: [],
    created: [],
    clearedItems: 0,
    clearedCarts: 0,
    sent: [],
    answers: [],
    afterOrder: [],
    stockChangesAnnounced: null,
  };

  t.mock.method(repo, 'getCustomerByTelegramId', async () => ({ id: 'c1', phone_number: '91234567' }));
  t.mock.method(stateStore, 'withLock', async (name, task) => {
    log.locks.push(name);
    return task();
  });
  t.mock.method(stateStore, 'get', async (key, fallback = null) => (
    key === stateStore.KEYS.preorderPost() ? { channelId: 'chan1', msgId: 111 } : fallback
  ));
  t.mock.method(orderStore, 'loadBlockedHalls', async () => ({ isBlocked: () => false }));
  t.mock.method(cartStore, 'getCart', async () => cart);
  t.mock.method(cartStore, 'clearItems', async () => { log.clearedItems += 1; });
  t.mock.method(cartStore, 'clearCart', async () => { log.clearedCarts += 1; });
  t.mock.method(menuStore, 'getFoodItemsOrThrow', async () => liveItems);
  t.mock.method(menuStore, 'restoreStock', async entries => {
    log.restores.push(entries);
    return { success: true };
  });

  const order = { id: 'o1', code: 'DG1', hallName: 'Hall A' };
  t.mock.method(orderStore, 'createPendingOrder', async args => {
    log.created.push(args);
    return order;
  });

  t.mock.method(admin, 'sendPaymentInstructions', async () => { log.afterOrder.push('payment_instructions'); });
  t.mock.method(admin, 'refreshDeliveryModeMenus', async () => { log.afterOrder.push('menus'); });
  t.mock.method(admin, 'refreshHallServeOrdersMessage', async () => { log.afterOrder.push('serve_list'); });
  t.mock.method(admin, 'refreshPreorderPostAfterStockChange', async (bot, changes) => {
    log.afterOrder.push('preorder_post');
    log.stockChangesAnnounced = changes;
  });

  const bot = {
    async answerCallbackQuery(id, opts) { log.answers.push(opts && opts.text); },
    async sendMessage(chatId, text) { log.sent.push(text); },
    async deleteMessage() {},
  };

  const query = { id: 'q1', from: { id: USER_ID, first_name: 'Sam' }, message: { message_id: 9, chat: { id: CHAT_ID } } };

  return { log, bot, query };
}

test('a successful confirm deducts stock atomically, creates the order and refreshes everything', async t => {
  const { log, bot, query } = setup(t);
  const changes = [{ name: 'Chicken Rice', oldStock: 5, newStock: 3 }];
  t.mock.method(menuStore, 'deductStock', async entries => {
    log.deductions.push(entries);
    return { success: true, changes };
  });

  await user.handleConfirmOrder(bot, query, CHAT_ID, USER_ID);

  assert.deepEqual(log.deductions, [[{ foodId: 3, quantity: 2, name: 'Chicken Rice' }]]);
  assert.equal(log.created.length, 1);
  assert.equal(log.created[0].totalCents, 500);
  assert.deepEqual(log.created[0].items, [
    { foodSheetRowId: 3, name: 'Chicken Rice', unitPriceCents: 250, quantity: 2 },
  ]);
  assert.equal(log.clearedCarts, 1);
  assert.deepEqual(log.restores, []);
  assert.deepEqual(log.afterOrder, ['payment_instructions', 'menus', 'preorder_post', 'serve_list']);
  // The levels the database reported, not ones worked out from an earlier read.
  assert.deepEqual(log.stockChangesAnnounced, changes);
});

test('the confirm lock is per customer, so different customers never queue behind each other', async t => {
  const { log, bot, query } = setup(t);
  t.mock.method(menuStore, 'deductStock', async () => ({ success: true, changes: [] }));

  await user.handleConfirmOrder(bot, query, CHAT_ID, USER_ID);

  assert.deepEqual(log.locks, [stateStore.LOCKS.confirmOrder(USER_ID)]);
  assert.notEqual(stateStore.LOCKS.confirmOrder(1), stateStore.LOCKS.confirmOrder(2));
});

test('an item already short in the menu read is refused before any deduction, naming the item', async t => {
  const { log, bot, query } = setup(t, {
    liveItems: [{ id: 3, name: 'Chicken Rice', price: 2.5, stock: 1 }],
  });
  t.mock.method(menuStore, 'deductStock', async () => { throw new Error('must not deduct'); });

  await user.handleConfirmOrder(bot, query, CHAT_ID, USER_ID);

  assert.equal(log.clearedItems, 1);
  assert.equal(log.created.length, 0);
  assert.match(log.sent[0], /Chicken Rice only has 1 left/);
  assert.match(log.sent[0], /cart has been cleared/);
});

test('someone else taking the stock between the read and the deduction is handled the same way', async t => {
  const { log, bot, query } = setup(t);
  t.mock.method(menuStore, 'deductStock', async () => ({
    success: false, reason: 'insufficient', name: 'Chicken Rice', available: 0,
  }));

  await user.handleConfirmOrder(bot, query, CHAT_ID, USER_ID);

  assert.equal(log.clearedItems, 1);
  assert.equal(log.created.length, 0);
  assert.match(log.sent[0], /Chicken Rice has just run out/);
  assert.deepEqual(log.afterOrder, []);
});

test('an item deleted after it was added is refused without a charge', async t => {
  const { log, bot, query } = setup(t, { liveItems: [] });
  t.mock.method(menuStore, 'deductStock', async () => { throw new Error('must not deduct'); });

  await user.handleConfirmOrder(bot, query, CHAT_ID, USER_ID);

  assert.equal(log.clearedItems, 1);
  assert.equal(log.created.length, 0);
  assert.match(log.sent[0], /menu changed/);
});

test('an item renamed after it was added is refused, not sold under its new name', async t => {
  const { log, bot, query } = setup(t, {
    liveItems: [{ id: 3, name: 'Fish Rice', price: 2.5, stock: 5 }],
  });
  t.mock.method(menuStore, 'deductStock', async () => { throw new Error('must not deduct'); });

  await user.handleConfirmOrder(bot, query, CHAT_ID, USER_ID);

  assert.equal(log.created.length, 0);
  assert.match(log.sent[0], /menu changed/);
});

test('if the order cannot be saved after the deduction, the stock is put back', async t => {
  const { log, bot, query } = setup(t);
  t.mock.method(menuStore, 'deductStock', async () => ({ success: true, changes: [] }));
  t.mock.method(orderStore, 'createPendingOrder', async () => { throw new Error('insert failed'); });

  await user.handleConfirmOrder(bot, query, CHAT_ID, USER_ID);

  assert.deepEqual(log.restores, [[{ id: 3, quantity: 2 }]]);
  assert.match(log.sent[0], /Could not save your order/);
  assert.deepEqual(log.afterOrder, []);
  assert.equal(log.clearedCarts, 0);
});

test('a restock that also fails is logged and does not crash the confirm', async t => {
  const { bot, query } = setup(t);
  t.mock.method(menuStore, 'deductStock', async () => ({ success: true, changes: [] }));
  t.mock.method(orderStore, 'createPendingOrder', async () => { throw new Error('insert failed'); });
  t.mock.method(menuStore, 'restoreStock', async () => ({ success: false, message: 'database down' }));

  await assert.doesNotReject(user.handleConfirmOrder(bot, query, CHAT_ID, USER_ID));
});

test('an empty cart creates nothing and deducts nothing', async t => {
  const { log, bot, query } = setup(t, { cart: { hallSheetRowId: 2, hallName: 'Hall A', items: {} } });
  t.mock.method(menuStore, 'deductStock', async () => { throw new Error('must not deduct'); });

  await user.handleConfirmOrder(bot, query, CHAT_ID, USER_ID);

  assert.equal(log.created.length, 0);
});
