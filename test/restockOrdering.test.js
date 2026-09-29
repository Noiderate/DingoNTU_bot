const test = require('node:test');
const assert = require('node:assert/strict');
const repo = require('../src/services/orderRepository');
const menuStore = require('../src/services/menuStore');
const googleSheets = require('../src/services/googleSheets');
const orderActions = require('../src/services/orderActions');

/**
 * Stock is only ever returned once an order's status transition has actually
 * won. Restocking first left phantom stock whenever the transition lost a race
 * (sweeper vs late screenshot, admin reject vs auto-approval), which then got
 * oversold.
 */

const { STATUS } = repo;

const ORDER_ROW = {
  id: 'o1',
  order_code: 'DG1',
  telegram_chat_id: 555,
  total_cents: 500,
  customers: {},
  order_items: [{ food_sheet_row_id: 3, item_name_snapshot: 'Chicken Rice', quantity: 2, unit_price_cents: 250 }],
};

const ORDER = {
  id: 'o1',
  code: 'DG1',
  items: [{ id: 3, name: 'Chicken Rice', quantity: 2 }],
};

function mockMenu(t, liveItems) {
  const restores = [];
  t.mock.method(menuStore, 'getFoodItemsOrThrow', async () => liveItems);
  t.mock.method(menuStore, 'restoreStock', async entries => {
    restores.push(...entries);
    return { success: true };
  });
  t.mock.method(googleSheets, 'getAdminIds', () => [42]);
  return restores;
}

test('expireOrder does not touch stock when another caller already moved the order on', async t => {
  const restores = mockMenu(t, [{ id: 3, name: 'Chicken Rice', stock: 5 }]);
  t.mock.method(repo, 'transitionOrderStatus', async () => null);

  const bot = { async sendMessage() { throw new Error('nobody should be messaged'); } };

  assert.equal(await orderActions.expireOrder(bot, ORDER), null);
  assert.deepEqual(restores, []);
});

test('expireOrder restocks after a successful transition', async t => {
  const restores = mockMenu(t, [{ id: 3, name: 'Chicken Rice', stock: 5 }]);
  t.mock.method(repo, 'transitionOrderStatus', async (id, from, to) => {
    assert.equal(to, STATUS.EXPIRED);
    return { ...ORDER_ROW, status: STATUS.EXPIRED };
  });

  const bot = { async sendMessage() {} };

  assert.ok(await orderActions.expireOrder(bot, ORDER));
  // The quantity to add back, not a computed new level: the database adds it
  // atomically, so it cannot overwrite a checkout that landed in between.
  assert.deepEqual(restores, [{ id: 3, quantity: 2 }]);
});

test('rejectOrderAndRestock does not touch stock when the transition loses the race', async t => {
  const restores = mockMenu(t, [{ id: 3, name: 'Chicken Rice', stock: 5 }]);
  t.mock.method(repo, 'transitionOrderStatus', async () => null);

  const result = await orderActions.rejectOrderAndRestock({ async sendMessage() {} }, ORDER, {
    fromStatus: STATUS.VERIFYING_PAYMENT, actor: 'admin', reason: 'test',
  });

  assert.equal(result.success, false);
  assert.deepEqual(restores, []);
});

test('restock follows the item by name when it was deleted and re-added under a new id', async t => {
  // Chicken Rice was removed and added again, so it now has a different id.
  const restores = mockMenu(t, [
    { id: 3, name: 'Milo', stock: 9 },
    { id: 9, name: 'Chicken Rice', stock: 5 },
  ]);

  const result = await orderActions.restockOrder(ORDER);

  assert.equal(result.success, true);
  assert.deepEqual(restores, [{ id: 9, quantity: 2 }]);
});

test('restock prefers the id-and-name match over a same-named item elsewhere', async t => {
  const restores = mockMenu(t, [
    { id: 3, name: 'Chicken Rice', stock: 1 },
  ]);

  const result = await orderActions.restockOrder(ORDER);

  assert.equal(result.success, true);
  assert.deepEqual(restores, [{ id: 3, quantity: 2 }]);
});

test('a restock that fails after the transition alerts admins with the items to add back', async t => {
  mockMenu(t, []); // item no longer on the menu
  t.mock.method(repo, 'transitionOrderStatus', async () => ({ ...ORDER_ROW, status: STATUS.REJECTED }));

  const messages = [];
  const bot = { async sendMessage(chatId, text) { messages.push({ chatId, text }); } };

  const result = await orderActions.rejectOrderAndRestock(bot, ORDER, {
    fromStatus: STATUS.PAYMENT_FLAGGED, actor: 'admin', reason: 'test', customerMessage: 'rejected',
  });

  assert.equal(result.success, true);
  assert.equal(result.restocked, false);
  const alert = messages.find(message => message.chatId === 42);
  assert.ok(alert, 'admin should be alerted');
  assert.match(alert.text, /Chicken Rice x2/);
});

test('a failed database write is reported as a failed restock, not thrown', async t => {
  t.mock.method(menuStore, 'getFoodItemsOrThrow', async () => [{ id: 3, name: 'Chicken Rice', stock: 5 }]);
  t.mock.method(menuStore, 'restoreStock', async () => ({ success: false, message: 'database down' }));

  const result = await orderActions.restockOrder(ORDER);

  assert.equal(result.success, false);
  assert.match(result.message, /database down/);
});

test('a failed menu read is reported as a failed restock, not thrown', async t => {
  t.mock.method(menuStore, 'getFoodItemsOrThrow', async () => { throw new Error('Menu read failed'); });

  const result = await orderActions.restockOrder(ORDER);

  assert.equal(result.success, false);
  assert.match(result.message, /Menu read failed/);
});
