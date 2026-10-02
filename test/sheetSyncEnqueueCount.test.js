const test = require('node:test');
const assert = require('node:assert/strict');

// orderRepository destructures getSupabase at load time, so the fake has to be
// in place before it is first required.
const supabaseModule = require('../src/services/supabase');

let upsertResult = { error: null };

supabaseModule.getSupabase = () => ({
  from: () => ({ upsert: async () => upsertResult }),
});

const { enqueueSheetSync, getSheetSyncEnqueueCount } = require('../src/services/orderRepository');

/**
 * The webhook drains the sheet outbox only when an update queued an order change.
 * It decides that by comparing this count before and after the update.
 */

test('queuing an order change raises the count', async () => {
  upsertResult = { error: null };
  const before = getSheetSyncEnqueueCount();

  await enqueueSheetSync('order-1');

  assert.equal(getSheetSyncEnqueueCount(), before + 1);
});

test('queuing the same order again still counts: its latest state needs pushing', async () => {
  upsertResult = { error: { code: '23505', message: 'duplicate key' } };
  const before = getSheetSyncEnqueueCount();

  await enqueueSheetSync('order-1');

  assert.equal(getSheetSyncEnqueueCount(), before + 1);
});

test('a failed enqueue does not count, since there is nothing in the outbox to drain', async t => {
  t.mock.method(console, 'error', () => {});
  upsertResult = { error: { code: 'XX000', message: 'db down' } };
  const before = getSheetSyncEnqueueCount();

  await enqueueSheetSync('order-1');

  assert.equal(getSheetSyncEnqueueCount(), before);
});
