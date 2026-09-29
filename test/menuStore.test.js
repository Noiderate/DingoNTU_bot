const test = require('node:test');
const assert = require('node:assert/strict');
const supabaseService = require('../src/services/supabase');
const menuStore = require('../src/services/menuStore');

/**
 * The menu lives in the menu_items table. These tests replace the database
 * client with a recorder, so they prove what menuStore asks the database for and
 * how it reads the answer - the SQL functions themselves (atomic deduction and
 * so on) are exercised against a real Postgres separately.
 */

/**
 * A stand-in for a supabase-js query builder: every method returns the same
 * chain, awaiting it yields `result`, and each call is recorded.
 */
function fakeClient({ tables = {}, rpc = {} } = {}) {
  const calls = [];

  function chain(table, result) {
    const c = { table };
    for (const method of ['select', 'order', 'insert', 'update', 'delete', 'eq']) {
      c[method] = (...args) => {
        calls.push({ table, method, args });
        return c;
      };
    }
    c.then = (resolve, reject) => Promise.resolve(result).then(resolve, reject);
    return c;
  }

  return {
    calls,
    from(table) {
      return chain(table, tables[table] || { data: [], error: null });
    },
    rpc(name, args) {
      calls.push({ table: null, method: 'rpc', args: [name, args] });
      const result = rpc[name];
      return Promise.resolve(typeof result === 'function' ? result(args) : result);
    },
  };
}

function useClient(t, client) {
  t.mock.method(supabaseService, 'getSupabase', () => client);
  return client;
}

const ok = data => ({ data, error: null });
const failed = (message, code) => ({ data: null, error: { message, code } });

// --- Reading -----------------------------------------------------------------

test('getFoodItemsOrThrow returns items with decimal prices, in id order', async t => {
  const client = useClient(t, fakeClient({
    tables: {
      menu_items: ok([
        { id: 1, name: 'Chicken Rice', price_cents: 250, stock: 12, baseline_stock: 20 },
        { id: '2', name: 'Iced Milo', price_cents: 199, stock: 0, baseline_stock: null },
      ]),
    },
  }));

  const items = await menuStore.getFoodItemsOrThrow();

  assert.deepEqual(items, [
    { id: 1, name: 'Chicken Rice', price: 2.5, stock: 12, baselineStock: 20 },
    { id: 2, name: 'Iced Milo', price: 1.99, stock: 0, baselineStock: null },
  ]);
  assert.deepEqual(client.calls.find(call => call.method === 'order').args, ['id', { ascending: true }]);
});

test('a failed read throws with code MENU_UNAVAILABLE instead of looking like an empty menu', async t => {
  useClient(t, fakeClient({ tables: { menu_items: failed('connection refused') } }));

  await assert.rejects(menuStore.getFoodItemsOrThrow(), error => {
    assert.equal(error.code, 'MENU_UNAVAILABLE');
    assert.equal(menuStore.isMenuUnavailable(error), true);
    return true;
  });
});

test('getFoodItems, the lenient reader, returns [] on a failed read', async t => {
  useClient(t, fakeClient({ tables: { menu_items: failed('connection refused') } }));
  t.mock.method(console, 'error', () => {});

  assert.deepEqual(await menuStore.getFoodItems(), []);
});

test('isMenuUnavailable only recognises the tagged error', () => {
  assert.equal(menuStore.isMenuUnavailable(new Error('plain')), false);
  assert.equal(menuStore.isMenuUnavailable(null), false);
});

// --- Adding, deleting, editing -----------------------------------------------

test('addFoodItem stores the price as whole cents, rounding rather than truncating', async t => {
  const client = useClient(t, fakeClient({ tables: { menu_items: ok([{ id: 1 }]) } }));

  const result = await menuStore.addFoodItem('  Chicken Burger ', 5.99);

  assert.equal(result.success, true);
  assert.match(result.message, /Chicken Burger/);
  const insert = client.calls.find(call => call.method === 'insert');
  // 5.99 * 100 is 598.9999999999999 in floating point: truncating would bill $5.98.
  assert.deepEqual(insert.args[0], { name: 'Chicken Burger', price_cents: 599 });
});

test('addFoodItem refuses an empty name or a bad price without touching the database', async t => {
  const client = useClient(t, fakeClient());

  assert.equal((await menuStore.addFoodItem('   ', 3)).success, false);
  assert.equal((await menuStore.addFoodItem('Rice', 'abc')).success, false);
  assert.equal((await menuStore.addFoodItem('Rice', -1)).success, false);
  assert.equal(client.calls.length, 0);
});

test('addFoodItem reports a duplicate name plainly', async t => {
  useClient(t, fakeClient({ tables: { menu_items: failed('duplicate key value', '23505') } }));

  const result = await menuStore.addFoodItem('Chicken Rice', 2.5);

  assert.equal(result.success, false);
  assert.match(result.message, /already on the menu/);
});

test('deleteFoodItem says so when the item was already gone', async t => {
  useClient(t, fakeClient({ tables: { menu_items: ok([]) } }));

  const result = await menuStore.deleteFoodItem(7);

  assert.equal(result.success, false);
  assert.match(result.message, /no longer exists/);
});

test('deleteFoodItem succeeds when a row was removed', async t => {
  useClient(t, fakeClient({ tables: { menu_items: ok([{ id: 7 }]) } }));

  assert.equal((await menuStore.deleteFoodItem(7)).success, true);
});

test('a manual stock edit sets both the stock and the reset baseline', async t => {
  const client = useClient(t, fakeClient({ tables: { menu_items: ok([{ name: 'Chicken Rice' }]) } }));

  const result = await menuStore.updateFoodItemStock(3, 25);

  assert.equal(result.success, true);
  assert.match(result.message, /Chicken Rice.*25/);
  const update = client.calls.find(call => call.method === 'update');
  assert.deepEqual(update.args[0], { stock: 25, baseline_stock: 25 });
  assert.deepEqual(client.calls.find(call => call.method === 'eq').args, ['id', 3]);
});

test('a stock edit for a deleted item fails cleanly', async t => {
  useClient(t, fakeClient({ tables: { menu_items: ok([]) } }));

  const result = await menuStore.updateFoodItemStock(3, 25);

  assert.equal(result.success, false);
});

// --- Checkout deduction ------------------------------------------------------

test('deductStock sends the cart to the database and maps the real before/after levels back', async t => {
  const client = useClient(t, fakeClient({
    rpc: {
      deduct_menu_stock: ok({
        ok: true,
        changes: [{ id: 3, name: 'Chicken Rice', old_stock: 5, new_stock: 3 }],
      }),
    },
  }));

  const result = await menuStore.deductStock([{ foodId: 3, quantity: 2, name: 'Chicken Rice' }]);

  assert.deepEqual(result, {
    success: true,
    changes: [{ name: 'Chicken Rice', oldStock: 5, newStock: 3 }],
  });
  const rpc = client.calls.find(call => call.method === 'rpc');
  assert.equal(rpc.args[0], 'deduct_menu_stock');
  assert.deepEqual(rpc.args[1], { p_items: [{ id: 3, quantity: 2 }] });
});

test('deductStock reports an item that ran short, naming it and how many are left', async t => {
  useClient(t, fakeClient({
    rpc: { deduct_menu_stock: ok({ ok: false, reason: 'insufficient', item_id: 3, name: 'Chicken Rice', available: 1 }) },
  }));

  const result = await menuStore.deductStock([{ foodId: 3, quantity: 2 }]);

  assert.deepEqual(result, { success: false, reason: 'insufficient', name: 'Chicken Rice', available: 1 });
});

test('deductStock reports an item that was deleted', async t => {
  useClient(t, fakeClient({
    rpc: { deduct_menu_stock: ok({ ok: false, reason: 'missing', item_id: 3 }) },
  }));

  const result = await menuStore.deductStock([{ foodId: 3, quantity: 2 }]);

  assert.equal(result.success, false);
  assert.equal(result.reason, 'missing');
});

test('deductStock throws MENU_UNAVAILABLE when the database call itself fails', async t => {
  useClient(t, fakeClient({ rpc: { deduct_menu_stock: failed('timeout') } }));

  await assert.rejects(menuStore.deductStock([{ foodId: 3, quantity: 2 }]), error => {
    assert.equal(error.code, 'MENU_UNAVAILABLE');
    return true;
  });
});

// --- Restocking --------------------------------------------------------------

test('restoreStock succeeds when every item was found', async t => {
  const client = useClient(t, fakeClient({ rpc: { restore_menu_stock: ok({ updated: 2 }) } }));

  const result = await menuStore.restoreStock([{ id: 3, quantity: 2 }, { id: 4, quantity: 1 }]);

  assert.deepEqual(result, { success: true });
  assert.deepEqual(client.calls.find(call => call.method === 'rpc').args[1], {
    p_items: [{ id: 3, quantity: 2 }, { id: 4, quantity: 1 }],
  });
});

test('restoreStock fails when an item was deleted in the meantime', async t => {
  useClient(t, fakeClient({ rpc: { restore_menu_stock: ok({ updated: 1 }) } }));

  const result = await menuStore.restoreStock([{ id: 3, quantity: 2 }, { id: 4, quantity: 1 }]);

  assert.equal(result.success, false);
  assert.match(result.message, /no longer on the menu/);
});

test('restoreStock counts an item listed twice once, since the database sums it into one row', async t => {
  useClient(t, fakeClient({ rpc: { restore_menu_stock: ok({ updated: 1 }) } }));

  const result = await menuStore.restoreStock([{ id: 3, quantity: 1 }, { id: 3, quantity: 1 }]);

  assert.equal(result.success, true);
});

test('restoreStock reports a database failure instead of throwing', async t => {
  useClient(t, fakeClient({ rpc: { restore_menu_stock: failed('timeout') } }));

  const result = await menuStore.restoreStock([{ id: 3, quantity: 2 }]);

  assert.equal(result.success, false);
  assert.match(result.message, /timeout/);
});

// --- Reset -------------------------------------------------------------------

test('restoreStockBaselines reports what changed and which items have no baseline yet', async t => {
  useClient(t, fakeClient({
    rpc: {
      restore_menu_baselines: ok([{ id: 3, name: 'Chicken Rice', old_stock: 4, new_stock: 20 }]),
    },
    tables: {
      menu_items: ok([
        { id: 3, name: 'Chicken Rice', price_cents: 250, stock: 20, baseline_stock: 20 },
        { id: 4, name: 'Iced Milo', price_cents: 199, stock: 7, baseline_stock: null },
      ]),
    },
  }));

  const result = await menuStore.restoreStockBaselines();

  assert.deepEqual(result.changes, [{ id: 3, name: 'Chicken Rice', oldStock: 4, newStock: 20 }]);
  assert.deepEqual(result.noBaselineItems, ['Iced Milo']);
});
