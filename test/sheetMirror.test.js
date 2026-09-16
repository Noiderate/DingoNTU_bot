const test = require('node:test');
const assert = require('node:assert/strict');

const { HEADERS, buildRow, STATUS_LABELS, PAYMENT_STATUS } = require('../src/services/sheetMirror');
const { STATUS } = require('../src/services/orderRepository');

/**
 * The Orders tab layout.
 *
 * The first eleven columns are the sheet staff already use. If these tests
 * fail, an existing column moved, which silently breaks whatever formulas and
 * filters they have built on top of it.
 */

const ORIGINAL_HEADERS = [
  'Timestamp', 'Order ID', 'Status', 'User ID', 'User Name', 'Username',
  'Hall', 'Items', 'Total', 'Admin ID', 'Processed At',
];

function makeOrder(overrides = {}) {
  return {
    order_code: 'DG20260916-7',
    status: STATUS.PAID,
    created_at: '2026-09-16T06:05:00.000Z',
    updated_at: '2026-09-16T06:20:00.000Z',
    admin_confirmed_at: '2026-09-16T06:10:00.000Z',
    paid_at: '2026-09-16T06:15:00.000Z',
    hall_name_snapshot: 'Eusoff Hall',
    total_cents: 1250,
    customers: { telegram_user_id: 999, first_name: 'Ali', telegram_username: 'ali' },
    order_items: [
      { item_name_snapshot: 'Chicken Rice', quantity: 1 },
      { item_name_snapshot: 'Iced Milo', quantity: 2 },
    ],
    ...overrides,
  };
}

test('the original eleven columns keep their headers and positions', () => {
  assert.deepEqual(HEADERS.slice(0, 11), ORIGINAL_HEADERS);
});

test('new columns are appended only to the right', () => {
  assert.deepEqual(HEADERS.slice(11), [
    'Order Code',
    'Order Status',
    'Payment Status',
    'Verification Outcome',
    'Verification Reasons',
    'Paid At (SGT)',
    'Last Updated (SGT)',
  ]);
});

test('a row has exactly one cell per header', () => {
  assert.equal(buildRow(makeOrder(), null).length, HEADERS.length);
});

test('a row carries the order through the original columns', () => {
  const row = buildRow(makeOrder(), null);

  assert.equal(row[0], '16/09/2026 14:05');       // Timestamp, SGT
  assert.equal(row[1], 'DG20260916-7');           // Order ID
  assert.equal(row[2], STATUS.PAID);              // raw status, for formulas
  assert.equal(row[3], 999);                      // User ID
  assert.equal(row[4], 'Ali');                    // User Name
  assert.equal(row[5], '@ali');                   // Username
  assert.equal(row[6], 'Eusoff Hall');            // Hall
  assert.equal(row[7], 'Chicken Rice x1, Iced Milo x2');
  assert.equal(row[8], '12.50');                  // Total, plain decimal
  assert.equal(row[10], '16/09/2026 14:10');      // Processed At
});

test('the order code column is what rows are matched on', () => {
  // Column L (index 11). syncOrder keys row lookups on this, so it must always
  // carry the code even if column B is ever repurposed.
  assert.equal(buildRow(makeOrder(), null)[11], 'DG20260916-7');
});

test('timestamps in the sheet are Singapore time, day first', () => {
  const row = buildRow(makeOrder(), null);
  assert.equal(row[16], '16/09/2026 14:15'); // Paid At
  assert.equal(row[17], '16/09/2026 14:20'); // Last Updated
});

test('missing timestamps render empty rather than as Invalid Date', () => {
  const row = buildRow(makeOrder({ paid_at: null, admin_confirmed_at: null }), null);
  assert.equal(row[10], '');
  assert.equal(row[16], '');
});

test('verification columns are blank until a receipt has been checked', () => {
  const row = buildRow(makeOrder(), null);
  assert.equal(row[14], '');
  assert.equal(row[15], '');
});

test('verification outcome and every reason code are recorded', () => {
  const row = buildRow(makeOrder(), {
    outcome: 'flagged',
    outcome_reasons: ['AMOUNT_MISMATCH', 'TIMESTAMP_TOO_OLD'],
  });

  assert.equal(row[14], 'flagged');
  assert.equal(row[15], 'AMOUNT_MISMATCH, TIMESTAMP_TOO_OLD');
});

test('a customer with no Telegram handle still renders', () => {
  const row = buildRow(
    makeOrder({ customers: { telegram_user_id: 999, first_name: 'Ali', telegram_username: null } }),
    null
  );
  assert.equal(row[5], '');
  assert.equal(row[4], 'Ali');
});

test('every order status has a human label and a payment status', () => {
  for (const status of Object.values(STATUS)) {
    assert.ok(STATUS_LABELS[status], `no label for ${status}`);
    assert.ok(PAYMENT_STATUS[status], `no payment status for ${status}`);
  }
});

test('unpaid statuses are not reported as paid', () => {
  assert.equal(PAYMENT_STATUS[STATUS.AWAITING_PAYMENT], 'Unpaid');
  assert.equal(PAYMENT_STATUS[STATUS.VERIFYING_PAYMENT], 'Checking');
  assert.equal(PAYMENT_STATUS[STATUS.PAYMENT_FLAGGED], 'Needs review');
  assert.equal(PAYMENT_STATUS[STATUS.PAID], 'Paid');
  // Served implies the food was handed over, and payment was settled by then.
  assert.equal(PAYMENT_STATUS[STATUS.SERVED], 'Paid');
});
