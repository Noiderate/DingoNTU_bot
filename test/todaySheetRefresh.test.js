const test = require('node:test');
const assert = require('node:assert/strict');

// todaySheet reads its orders through supabase.getSupabase, which it destructures
// at load time, so the fake has to be in place before it is first required.
const supabaseModule = require('../src/services/supabase');

let currentOrders = [];

function fakeClient() {
  const query = {
    select: () => query,
    gte: () => query,
    lt: () => query,
    order: async () => ({ data: currentOrders, error: null }),
  };
  return { from: () => query };
}

supabaseModule.getSupabase = fakeClient;

const googleSheets = require('../src/services/googleSheets');
const stateStore = require('../src/services/stateStore');
const { refreshTodaySheet } = require('../src/services/todaySheet');

/**
 * The Today's Orders tab is rebuilt by every tick. Rewriting an identical tab is
 * wasted Sheets quota and CPU, so it is skipped when nothing changed - but never
 * at the cost of leaving a failed or tampered-with tab wrong.
 */

function makeOrder(code, overrides = {}) {
  return {
    order_code: code,
    status: 'paid',
    created_at: '2026-09-16T15:21:00.000Z',
    hall_name_snapshot: 'Eusoff Hall',
    customers: { telegram_user_id: 1, first_name: 'Ali', telegram_username: 'ali' },
    order_items: [{ item_name_snapshot: 'Chicken Rice', quantity: 1 }],
    ...overrides,
  };
}

function setup(t, { saved = null, lock = 'holder-1', clearOk = true, writeOk = true } = {}) {
  const calls = { clears: 0, writes: 0, formats: 0 };
  const state = { value: saved };

  t.mock.method(stateStore, 'acquireLock', async () => lock);
  t.mock.method(stateStore, 'get', async (key, fallback = null) => (
    key === stateStore.KEYS.todaySheetSync() && state.value ? state.value : fallback
  ));
  t.mock.method(stateStore, 'set', async (key, value) => {
    if (key === stateStore.KEYS.todaySheetSync()) {
      state.value = value;
    }
  });
  t.mock.method(googleSheets, 'ensureSheetTab', async () => 7);
  t.mock.method(googleSheets, 'clearRange', async () => { calls.clears += 1; return clearOk; });
  t.mock.method(googleSheets, 'writeToSheet', async () => { calls.writes += 1; return writeOk; });
  t.mock.method(googleSheets, 'batchUpdateSpreadsheet', async () => { calls.formats += 1; });

  return { calls, state };
}

test('the first refresh writes the tab and records what it wrote', async t => {
  currentOrders = [makeOrder('A1')];
  const { calls, state } = setup(t);

  const result = await refreshTodaySheet();

  assert.deepEqual(result, { orders: 1, items: 1 });
  assert.deepEqual(calls, { clears: 1, writes: 1, formats: 1 });
  assert.ok(state.value.hash);
});

test('an unchanged tab costs no Sheets call at all', async t => {
  currentOrders = [makeOrder('A1')];
  const first = setup(t);
  await refreshTodaySheet();
  t.mock.restoreAll();

  const { calls } = setup(t, { saved: first.state.value });
  const result = await refreshTodaySheet();

  assert.equal(result.skipped, 'unchanged');
  assert.deepEqual(calls, { clears: 0, writes: 0, formats: 0 });
});

test('a new order changes the content, so the tab is rewritten', async t => {
  currentOrders = [makeOrder('A1')];
  const first = setup(t);
  await refreshTodaySheet();
  t.mock.restoreAll();

  currentOrders = [makeOrder('A1'), makeOrder('A2')];
  const { calls } = setup(t, { saved: first.state.value });
  const result = await refreshTodaySheet();

  assert.deepEqual(result, { orders: 2, items: 1 });
  assert.equal(calls.writes, 1);
});

test('a status change on an existing order is a change too', async t => {
  currentOrders = [makeOrder('A1', { status: 'awaiting_payment' })];
  const first = setup(t);
  await refreshTodaySheet();
  t.mock.restoreAll();

  currentOrders = [makeOrder('A1', { status: 'paid' })];
  const { calls } = setup(t, { saved: first.state.value });
  await refreshTodaySheet();

  assert.equal(calls.writes, 1);
});

test('an unchanged tab is still rewritten once the last write is old, so edits to it heal', async t => {
  currentOrders = [makeOrder('A1')];
  const first = setup(t);
  await refreshTodaySheet();
  t.mock.restoreAll();

  const stale = { ...first.state.value, writtenAt: Date.now() - 11 * 60 * 1000 };
  const { calls } = setup(t, { saved: stale });
  const result = await refreshTodaySheet();

  assert.equal(result.skipped, undefined);
  assert.equal(calls.writes, 1);
});

test('a failed write is not recorded as done, so the next tick retries it', async t => {
  currentOrders = [makeOrder('A1')];
  const { state } = setup(t, { writeOk: false });

  const result = await refreshTodaySheet();

  assert.deepEqual(result, { written: false });
  assert.equal(state.value, null);
});

test('a failed clear is not recorded as done either', async t => {
  currentOrders = [makeOrder('A1')];
  const { calls, state } = setup(t, { clearOk: false });

  const result = await refreshTodaySheet();

  assert.deepEqual(result, { written: false });
  assert.equal(calls.writes, 1);
  assert.equal(state.value, null);
});

test('inside the lease window the refresh is throttled before anything is read or written', async t => {
  currentOrders = [makeOrder('A1')];
  const { calls } = setup(t, { lock: null });

  assert.deepEqual(await refreshTodaySheet(), { throttled: true });
  assert.deepEqual(calls, { clears: 0, writes: 0, formats: 0 });
});
