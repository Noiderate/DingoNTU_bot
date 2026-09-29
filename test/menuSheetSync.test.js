const test = require('node:test');
const assert = require('node:assert/strict');
const googleSheets = require('../src/services/googleSheets');
const menuStore = require('../src/services/menuStore');
const stateStore = require('../src/services/stateStore');
const { syncMenuToSheet } = require('../src/services/menuSheetSync');

/**
 * The FoodAndStock tab is a one-way, read-only mirror of the database. The rules
 * that matter: it is never blanked, it costs nothing while the menu is
 * unchanged, a shorter menu leaves no stale rows behind, and a failed write is
 * never recorded as done (so the next tick retries it).
 */

const ITEMS = [
  { id: 1, name: 'Chicken Rice', price: 2.5, stock: 12 },
  { id: 2, name: 'Iced Milo', price: 1.99, stock: 0 },
];

/**
 * Sets up the mirror's collaborators. `saved` stands in for the bot_state row
 * that remembers what was last written.
 */
function setup(t, { items = ITEMS, saved = null, lock = 'holder-1', writeOk = true, clearOk = true } = {}) {
  const writes = [];
  const clears = [];
  const state = { value: saved };

  t.mock.method(menuStore, 'getFoodItemsOrThrow', async () => items);
  t.mock.method(stateStore, 'get', async (key, fallback = null) => (
    key === stateStore.KEYS.menuSheetSync() && state.value ? state.value : fallback
  ));
  t.mock.method(stateStore, 'set', async (key, value) => {
    if (key === stateStore.KEYS.menuSheetSync()) {
      state.value = value;
    }
  });
  t.mock.method(stateStore, 'acquireLock', async () => lock);
  t.mock.method(googleSheets, 'writeToSheet', async (range, values) => {
    writes.push({ range, values });
    return writeOk;
  });
  t.mock.method(googleSheets, 'clearRange', async range => {
    clears.push(range);
    return clearOk;
  });

  return { writes, clears, state };
}

test('an empty menu is never mirrored, so the sheet is not blanked', async t => {
  const { writes, clears } = setup(t, { items: [] });

  assert.deepEqual(await syncMenuToSheet(), { skipped: 'empty_menu' });
  assert.deepEqual(writes, []);
  assert.deepEqual(clears, []);
});

test('the first sync clears the tab, writes the menu and leaves a read-only note', async t => {
  const { writes, clears, state } = setup(t);

  assert.deepEqual(await syncMenuToSheet(), { synced: 2 });

  assert.deepEqual(clears, ['FoodAndStock!A2:C']);
  assert.deepEqual(writes[0], {
    range: 'FoodAndStock!A2',
    values: [['Chicken Rice', 2.5, 12], ['Iced Milo', 1.99, 0]],
  });
  assert.equal(writes[1].range, 'FoodAndStock!E1');
  assert.match(writes[1].values[0][0], /Read-only/);
  assert.equal(state.value.rowCount, 2);
  assert.ok(state.value.hash);
});

test('an unchanged menu costs no write and does not even take the lock', async t => {
  const first = setup(t);
  await syncMenuToSheet();
  t.mock.restoreAll();

  const { writes, clears } = setup(t, { saved: first.state.value });
  t.mock.method(stateStore, 'acquireLock', async () => { throw new Error('must not take the lock'); });

  assert.deepEqual(await syncMenuToSheet(), { skipped: 'unchanged' });
  assert.deepEqual(writes, []);
  assert.deepEqual(clears, []);
});

test('a stock change is written in one call, with no clear and no note', async t => {
  const first = setup(t);
  await syncMenuToSheet();
  t.mock.restoreAll();

  const changed = ITEMS.map(item => (item.id === 1 ? { ...item, stock: 11 } : item));
  const { writes, clears } = setup(t, { items: changed, saved: first.state.value });

  assert.deepEqual(await syncMenuToSheet(), { synced: 2 });

  assert.deepEqual(clears, []);
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].values[0], ['Chicken Rice', 2.5, 11]);
});

test('a shorter menu pads blank rows over the ones it no longer fills', async t => {
  const first = setup(t);
  await syncMenuToSheet();
  t.mock.restoreAll();

  const { writes } = setup(t, { items: [ITEMS[0]], saved: first.state.value });

  assert.deepEqual(await syncMenuToSheet(), { synced: 1 });

  assert.deepEqual(writes[0].values, [['Chicken Rice', 2.5, 12], ['', '', '']]);
});

test('a sync inside the interval is throttled, writes nothing and records nothing', async t => {
  const { writes, clears, state } = setup(t, { lock: null });

  assert.deepEqual(await syncMenuToSheet(), { throttled: true });
  assert.deepEqual(writes, []);
  assert.deepEqual(clears, []);
  assert.equal(state.value, null);
});

test('a failed write throws and is not recorded, so the next tick retries it', async t => {
  const { state } = setup(t, { writeOk: false });

  await assert.rejects(syncMenuToSheet(), /Could not write the FoodAndStock sheet/);
  assert.equal(state.value, null);
});

test('a failed clear throws before anything is written', async t => {
  const { writes } = setup(t, { clearOk: false });

  await assert.rejects(syncMenuToSheet(), /Could not clear the FoodAndStock sheet/);
  assert.deepEqual(writes, []);
});
