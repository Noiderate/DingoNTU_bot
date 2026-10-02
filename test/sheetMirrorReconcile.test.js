const test = require('node:test');
const assert = require('node:assert/strict');

// sheetMirror destructures getSupabase at load time, so the fake has to be in
// place before it is first required.
const supabaseModule = require('../src/services/supabase');

const db = { stale: [], alreadyQueued: new Set(), upserts: [], upsertError: null };

function fakeClient() {
  return {
    from(table) {
      if (table === 'orders') {
        const query = {
          select: () => query,
          or: () => query,
          order: () => query,
          limit: async () => ({ data: db.stale, error: null }),
        };
        return query;
      }

      return {
        upsert(rows, options) {
          db.upserts.push({ rows, options });
          // What ignoreDuplicates does: rows already queued are skipped and are
          // not returned.
          return {
            select: async () => (db.upsertError
              ? { data: null, error: db.upsertError }
              : { data: rows.filter(row => !db.alreadyQueued.has(row.order_id)), error: null }),
          };
        },
      };
    },
  };
}

supabaseModule.getSupabase = fakeClient;

const { reconcile } = require('../src/services/sheetMirror');

/**
 * reconcile used to overwrite every order's outbox entry with "retry now", once
 * per order, every minute. That skipped the backoff meant to give an overloaded
 * Sheets API room, and it re-queued a permanently failing order forever. It now
 * only fills in entries that are missing.
 */

test.beforeEach(() => {
  Object.assign(db, { stale: [], alreadyQueued: new Set(), upserts: [], upsertError: null });
});

test('with nothing behind, it makes no write at all', async () => {
  assert.deepEqual(await reconcile(), { requeued: 0 });
  assert.deepEqual(db.upserts, []);
});

test('it adds missing entries in one statement that never overwrites an existing one', async () => {
  db.stale = [{ id: 'o1' }, { id: 'o2' }, { id: 'o3' }];

  const result = await reconcile();

  assert.equal(result.requeued, 3);
  assert.equal(db.upserts.length, 1, 'one batched write, not one per order');
  assert.deepEqual(db.upserts[0].options, { onConflict: 'order_id', ignoreDuplicates: true });
  assert.deepEqual(db.upserts[0].rows.map(row => row.order_id), ['o1', 'o2', 'o3']);
  assert.ok(db.upserts[0].rows.every(row => row.next_attempt_at));
});

test('an order that is already queued is left alone and not counted', async () => {
  db.stale = [{ id: 'o1' }, { id: 'o2' }];
  db.alreadyQueued = new Set(['o1']);

  const result = await reconcile();

  assert.equal(result.requeued, 1);
});

test('a failed write is reported as nothing requeued instead of throwing', async t => {
  t.mock.method(console, 'warn', () => {});
  db.stale = [{ id: 'o1' }];
  db.upsertError = { message: 'db down' };

  assert.deepEqual(await reconcile(), { requeued: 0 });
});
