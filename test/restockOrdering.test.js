const test = require('node:test');
const assert = require('node:assert/strict');
const repo = require('../src/services/orderRepository');
const stateStore = require('../src/services/stateStore');
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

function mockSheets(t, liveItems) {
  const writes = [];
  t.mock.method(stateStore, 'withLock', async (name, task) => {
    assert.equal(name, stateStore.LOCKS.confirmOrder());
    return task();
  });
  t.mock.method(googleSheets, 'getFoodItemsOrThrow', async () => liveItems);
  t.mock.method(googleSheets, 'updateFoodItemStocksBatch', async updates => {
    writes.push(...updates);
    return { success: true };
  });
  t.mock.method(googleSheets, 'getAdminIds', () => [42]);
  return writes;
}

test('expireOrder does not touch stock when another caller already moved the order on', async t => {
  const writes = mockSheets(t, [{ id: 3, name: 'Chicken Rice', stock: 5 }]);
  t.mock.method(repo, 'transitionOrderStatus', async () => null);

  const bot = { async sendMessage() { throw new Error('nobody should be messaged'); } };

  assert.equal(await orderActions.expireOrder(bot, ORDER), null);
  assert.deepEqual(writes, []);
});

test('expireOrder restocks after a successful transition, under the checkout lock', async t => {
  const writes = mockSheets(t, [{ id: 3, name: 'Chicken Rice', stock: 5 }]);
  t.mock.method(repo, 'transitionOrderStatus', async (id, from, to) => {
    assert.equal(to, STATUS.EXPIRED);
    return { ...ORDER_ROW, status: STATUS.EXPIRED };
  });

  const bot = { async sendMessage() {} };

  assert.ok(await orderActions.expireOrder(bot, ORDER));
  assert.deepEqual(writes, [{ rowId: 3, newStock: 7 }]);
});

test('rejectOrderAndRestock does not touch stock when the transition loses the race', async t => {
  const writes = mockSheets(t, [{ id: 3, name: 'Chicken Rice', stock: 5 }]);
  t.mock.method(repo, 'transitionOrderStatus', async () => null);

  const result = await orderActions.rejectOrderAndRestock({ async sendMessage() {} }, ORDER, {
    fromStatus: STATUS.VERIFYING_PAYMENT, actor: 'admin', reason: 'test',
  });

  assert.equal(result.success, false);
  assert.deepEqual(writes, []);
});

test('restock follows the item by name when its sheet row has shifted', async t => {
  // Row 3 now holds a different food; Chicken Rice moved to row 4.
  const writes = mockSheets(t, [
    { id: 3, name: 'Milo', stock: 9 },
    { id: 4, name: 'Chicken Rice', stock: 5 },
  ]);

  const result = await orderActions.restockOrder(ORDER);

  assert.equal(result.success, true);
  assert.deepEqual(writes, [{ rowId: 4, newStock: 7 }]);
});

test('a restock that fails after the transition alerts admins with the items to add back', async t => {
  mockSheets(t, []); // item no longer in the sheet
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

test('a failed sheet read is reported as a failed restock, not thrown', async t => {
  t.mock.method(stateStore, 'withLock', async (name, task) => task());
  t.mock.method(googleSheets, 'getFoodItemsOrThrow', async () => { throw new Error('Sheets down'); });

  const result = await orderActions.restockOrder(ORDER);

  assert.equal(result.success, false);
  assert.match(result.message, /Sheets down/);
});
