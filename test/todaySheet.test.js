const test = require('node:test');
const assert = require('node:assert/strict');
const { DateTime } = require('luxon');

const { HEADERS, buildOrderRow, buildItemTotals, getServiceDayWindow } = require('../src/services/todaySheet');
const { STATUS } = require('../src/services/orderRepository');
const { STATUS_LABELS, PAYMENT_STATUS } = require('../src/services/sheetMirror');
const { SGT } = require('../src/utils/time');

function makeOrder(overrides = {}) {
  return {
    order_code: 'DG20260916-7',
    status: STATUS.PAID,
    created_at: '2026-09-16T15:21:00.000Z', // 23:21 SGT
    hall_name_snapshot: 'Eusoff Hall',
    customers: { telegram_user_id: 999, first_name: 'Ali', telegram_username: 'ali' },
    order_items: [
      { item_name_snapshot: 'Chicken Rice', quantity: 1 },
      { item_name_snapshot: 'Iced Milo', quantity: 2 },
    ],
    ...overrides,
  };
}

test('columns are order id, time, handle, hall, items, order status, payment status', () => {
  assert.deepEqual(HEADERS, [
    'Order ID', 'Time', 'Telegram Handle', 'Hall', 'Items', 'Order Status', 'Payment Status',
  ]);
});

test('a row has exactly one cell per header', () => {
  assert.equal(buildOrderRow(makeOrder()).length, HEADERS.length);
});

test('the time column is bare HH:mm, not a full timestamp', () => {
  const row = buildOrderRow(makeOrder());
  assert.equal(row[1], '23:21');
});

test('a single-digit hour still renders zero-padded', () => {
  const row = buildOrderRow(makeOrder({ created_at: '2026-09-15T17:32:00.000Z' })); // 01:32 SGT
  assert.equal(row[1], '01:32');
});

test('a row carries the order through every column', () => {
  const row = buildOrderRow(makeOrder());

  assert.equal(row[0], 'DG20260916-7');                    // Order ID
  assert.equal(row[2], '@ali');                             // Telegram Handle
  assert.equal(row[3], 'Eusoff Hall');                      // Hall
  assert.equal(row[4], 'Chicken Rice x1, Iced Milo x2');    // Items
  assert.equal(row[5], STATUS_LABELS[STATUS.PAID]);         // Order Status
  assert.equal(row[6], PAYMENT_STATUS[STATUS.PAID]);        // Payment Status
});

test('a customer with no username falls back to their first name', () => {
  const row = buildOrderRow(makeOrder({
    customers: { telegram_user_id: 999, first_name: 'Ali', telegram_username: null },
  }));
  assert.equal(row[2], 'Ali');
});

test('a customer with neither falls back to their Telegram id', () => {
  const row = buildOrderRow(makeOrder({
    customers: { telegram_user_id: 999, first_name: null, telegram_username: null },
  }));
  assert.equal(row[2], '999');
});

test('item totals sum quantities across every order today', () => {
  const orders = [
    makeOrder({ order_items: [{ item_name_snapshot: 'Chicken Rice', quantity: 2 }] }),
    makeOrder({ order_items: [{ item_name_snapshot: 'Chicken Rice', quantity: 1 }, { item_name_snapshot: 'Iced Milo', quantity: 3 }] }),
  ];

  assert.deepEqual(buildItemTotals(orders), [
    ['Chicken Rice', 3],
    ['Iced Milo', 3],
  ]);
});

test('rejected, cancelled and expired orders are excluded from totals', () => {
  const orders = [
    makeOrder({ status: STATUS.PAID, order_items: [{ item_name_snapshot: 'Chicken Rice', quantity: 1 }] }),
    makeOrder({ status: STATUS.REJECTED, order_items: [{ item_name_snapshot: 'Chicken Rice', quantity: 5 }] }),
    makeOrder({ status: STATUS.CANCELLED, order_items: [{ item_name_snapshot: 'Chicken Rice', quantity: 5 }] }),
    makeOrder({ status: STATUS.EXPIRED, order_items: [{ item_name_snapshot: 'Chicken Rice', quantity: 5 }] }),
  ];

  assert.deepEqual(buildItemTotals(orders), [['Chicken Rice', 1]]);
});

test('an in-flight order (awaiting payment, flagged, etc) still counts toward totals', () => {
  const orders = [
    makeOrder({ status: STATUS.AWAITING_PAYMENT, order_items: [{ item_name_snapshot: 'Iced Milo', quantity: 2 }] }),
  ];

  assert.deepEqual(buildItemTotals(orders), [['Iced Milo', 2]]);
});

test('ties in quantity break alphabetically', () => {
  const orders = [
    makeOrder({ order_items: [{ item_name_snapshot: 'Zebra Cake', quantity: 2 }] }),
    makeOrder({ order_items: [{ item_name_snapshot: 'Apple Pie', quantity: 2 }] }),
  ];

  assert.deepEqual(buildItemTotals(orders), [
    ['Apple Pie', 2],
    ['Zebra Cake', 2],
  ]);
});

test('no orders today produces no totals', () => {
  assert.deepEqual(buildItemTotals([]), []);
});

// The business runs a night delivery operation. "Today" must therefore be a
// service day running 3pm to 3pm, not a calendar day - otherwise one night's
// orders would split across two buckets right as delivery crosses midnight.

test('late evening: the service day started at 3pm today, and runs to 3pm tomorrow', () => {
  const now = DateTime.fromISO('2026-09-16T23:21:00', { zone: SGT });
  const { start, end } = getServiceDayWindow(now);

  assert.equal(start.toISO(), DateTime.fromISO('2026-09-16T15:00:00', { zone: SGT }).toISO());
  assert.equal(end.toISO(), DateTime.fromISO('2026-09-17T15:00:00', { zone: SGT }).toISO());
});

test('past midnight: still belongs to the service day that started the previous afternoon', () => {
  const now = DateTime.fromISO('2026-09-17T01:32:00', { zone: SGT });
  const { start, end } = getServiceDayWindow(now);

  assert.equal(start.toISO(), DateTime.fromISO('2026-09-16T15:00:00', { zone: SGT }).toISO());
  assert.equal(end.toISO(), DateTime.fromISO('2026-09-17T15:00:00', { zone: SGT }).toISO());
});

test('mid-afternoon, before the cutoff: still the previous service day', () => {
  const now = DateTime.fromISO('2026-09-16T14:59:00', { zone: SGT });
  const { start } = getServiceDayWindow(now);

  assert.equal(start.toISO(), DateTime.fromISO('2026-09-15T15:00:00', { zone: SGT }).toISO());
});

test('exactly at the cutoff: the new service day has begun', () => {
  const now = DateTime.fromISO('2026-09-16T15:00:00', { zone: SGT });
  const { start } = getServiceDayWindow(now);

  assert.equal(start.toISO(), DateTime.fromISO('2026-09-16T15:00:00', { zone: SGT }).toISO());
});
