const test = require('node:test');
const assert = require('node:assert/strict');
const { computeStats, formatFunStats, summariseSoldOut } = require('../src/services/statsService');

const order = (overrides = {}) => ({
  status: 'paid',
  total_cents: 500,
  // 12:30 SGT
  created_at: '2026-09-16T04:30:00Z',
  paid_at: '2026-09-16T04:30:45Z',
  hall_name_snapshot: 'Hall A',
  customer_id: 'c1',
  customers: { first_name: 'Sam' },
  order_items: [{ item_name_snapshot: 'Mala', quantity: 2 }],
  ...overrides,
});

test('computeStats totals only paid and served orders', () => {
  const stats = computeStats([
    order(),
    order({ status: 'served', total_cents: 700 }),
    order({ status: 'expired', total_cents: 9999 }),
  ]);

  assert.equal(stats.orders, 2);
  assert.equal(stats.revenueCents, 1200);
  assert.equal(stats.averageCents, 600);
  assert.equal(stats.itemsSold, 4);
  assert.equal(stats.biggestCents, 700);
});

test('computeStats picks the favourites, busiest hour and repeat customers', () => {
  const stats = computeStats([
    order(),
    order({ order_items: [{ item_name_snapshot: 'Chicken', quantity: 1 }], hall_name_snapshot: 'Hall B', customer_id: 'c2', customers: { first_name: 'Lee' } }),
    order({ paid_at: '2026-09-16T04:30:10Z' }),
  ]);

  assert.deepEqual(stats.topItem, { name: 'Mala', value: 4 });
  assert.deepEqual(stats.topHall, { name: 'Hall A', value: 2 });
  assert.deepEqual(stats.busiestHour, { name: 12, value: 3 });
  assert.deepEqual(stats.topCustomer, { name: 'Sam', value: 2 });
  assert.equal(stats.uniqueCustomers, 2);
  assert.equal(stats.repeatCustomers, 1);
  assert.equal(stats.fastestPayMs, 10000);
});

test('computeStats and formatFunStats cope with no orders', () => {
  const stats = computeStats([]);

  assert.equal(stats.orders, 0);
  assert.match(formatFunStats(stats, false), /No paid orders yet/);
});

test('computeStats finds the busiest day in Singapore time', () => {
  const stats = computeStats([
    order({ created_at: '2026-09-16T04:00:00Z' }),
    order({ created_at: '2026-09-16T10:00:00Z' }),
    // 00:30 SGT on the 17th, still the 16th in UTC
    order({ created_at: '2026-09-16T16:30:00Z' }),
  ]);

  // The label comes from Intl, whose punctuation differs between Node/ICU
  // versions ("Wed, 16 Sept" on Node 20, "Wed 16 Sept" on 22 and later). What
  // matters is which day the orders were grouped under and how many landed there.
  assert.match(stats.busiestDay.name, /^Wed,? 16 Sept?$/);
  assert.equal(stats.busiestDay.value, 2);
});

test('summariseSoldOut reports the total and the item that sells out most', () => {
  assert.deepEqual(summariseSoldOut(null), { total: 0, top: null });
  assert.deepEqual(
    summariseSoldOut({ total: 3, items: { Mala: 2, Chicken: 1 } }),
    { total: 3, top: { name: 'Mala', value: 2 } }
  );
  assert.match(formatFunStats({ ...computeStats([order()]), soldOut: { total: 3, top: { name: 'Mala', value: 2 } } }, false), /Sold-out moments: 3 - Mala goes fastest \(2x\)/);
});