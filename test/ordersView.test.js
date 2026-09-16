const test = require('node:test');
const assert = require('node:assert/strict');

const { buildOrdersPageText, buildOrdersKeyboard, USER_CALLBACKS, ORDERS_PAGE_SIZE } = require('../src/handlers/user');
const { STATUS } = require('../src/services/orderRepository');

/**
 * Formatting and pagination for the customer-facing /orders command.
 * These operate on raw database rows, so no database is needed.
 */

function makeRow(overrides = {}) {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    order_code: 'DG20260916-7',
    status: STATUS.PAID,
    created_at: '2026-09-16T06:05:00.000Z',
    telegram_chat_id: 12345,
    hall_name_snapshot: 'Eusoff Hall',
    total_cents: 1250,
    rejection_reason: null,
    customers: { telegram_user_id: 999, first_name: 'Ali', telegram_username: 'ali' },
    order_items: [
      {
        food_sheet_row_id: 2,
        item_name_snapshot: 'Chicken Rice',
        unit_price_cents: 650,
        quantity: 1,
        line_total_cents: 650,
      },
      {
        food_sheet_row_id: 3,
        item_name_snapshot: 'Iced Milo',
        unit_price_cents: 300,
        quantity: 2,
        line_total_cents: 600,
      },
    ],
    ...overrides,
  };
}

test('an order shows its code, time, hall, items and total', () => {
  const text = buildOrdersPageText([makeRow()], 0, 1);

  assert.match(text, /DG20260916-7/);
  assert.match(text, /16 Sep 2026/);
  assert.match(text, /Eusoff Hall/);
  assert.match(text, /Chicken Rice x1/);
  assert.match(text, /Iced Milo x2/);
  assert.match(text, /\$12\.50/);
});

test('times are shown in Singapore time', () => {
  // 06:05 UTC is 2:05 PM in Singapore.
  const text = buildOrdersPageText([makeRow()], 0, 1);
  assert.match(text, /2:05/);
});

test('each status gets a friendly label rather than the raw enum', () => {
  const expectations = [
    [STATUS.PENDING_ADMIN_CONFIRMATION, /Awaiting admin confirmation/],
    [STATUS.AWAITING_PAYMENT, /Awaiting payment/],
    [STATUS.VERIFYING_PAYMENT, /Verifying payment/],
    [STATUS.PAYMENT_FLAGGED, /Payment under review/],
    [STATUS.PAID, /Paid/],
    [STATUS.SERVED, /Served \/ Delivered/],
    [STATUS.REJECTED, /Rejected/],
    [STATUS.CANCELLED, /Cancelled/],
    [STATUS.EXPIRED, /Expired/],
  ];

  for (const [status, pattern] of expectations) {
    const text = buildOrdersPageText([makeRow({ status })], 0, 1);
    assert.match(text, pattern, `missing label for ${status}`);
    assert.ok(!text.includes(`   ${status}\n`), `raw enum leaked for ${status}`);
  }
});

test('a rejection reason is shown when there is one', () => {
  const text = buildOrdersPageText(
    [makeRow({ status: STATUS.REJECTED, rejection_reason: 'Sent too late' })],
    0, 1
  );
  assert.match(text, /Sent too late/);
});

test('the page counter reflects the total, not the page size', () => {
  assert.match(buildOrdersPageText([makeRow()], 0, 12), /page 1 of 3/);
  assert.match(buildOrdersPageText([makeRow()], 2, 12), /page 3 of 3/);
  assert.match(buildOrdersPageText([makeRow()], 0, 1), /page 1 of 1/);
});

test('an order with no items still renders', () => {
  const text = buildOrdersPageText([makeRow({ order_items: [] })], 0, 1);
  assert.match(text, /no items/);
});

test('delivery details appear only when present', () => {
  const without = buildOrdersPageText([makeRow()], 0, 1);
  assert.ok(!without.includes('📦'));

  const withDetails = buildOrdersPageText(
    [makeRow({ recipient_name: 'Ali', delivery_address: '12 Clementi Rd', postal_code: '129742' })],
    0, 1
  );
  assert.match(withDetails, /12 Clementi Rd/);
  assert.match(withDetails, /129742/);
});


// --- Pagination --------------------------------------------------------------

test('a single page needs no navigation buttons', () => {
  assert.equal(buildOrdersKeyboard(0, 3), undefined);
  assert.equal(buildOrdersKeyboard(0, ORDERS_PAGE_SIZE), undefined);
});

test('the first page offers Next only', () => {
  const keyboard = buildOrdersKeyboard(0, 12);
  const labels = keyboard.inline_keyboard[0].map(button => button.text);

  assert.deepEqual(labels, ['Next ▶']);
  assert.equal(keyboard.inline_keyboard[0][0].callback_data, `${USER_CALLBACKS.ORDERS_PAGE_PREFIX}1`);
});

test('a middle page offers both directions', () => {
  const labels = buildOrdersKeyboard(1, 12).inline_keyboard[0].map(button => button.text);
  assert.deepEqual(labels, ['◀ Previous', 'Next ▶']);
});

test('the last page offers Previous only', () => {
  const keyboard = buildOrdersKeyboard(2, 12);
  const labels = keyboard.inline_keyboard[0].map(button => button.text);

  assert.deepEqual(labels, ['◀ Previous']);
  assert.equal(keyboard.inline_keyboard[0][0].callback_data, `${USER_CALLBACKS.ORDERS_PAGE_PREFIX}1`);
});

test('the orders callback prefix cannot collide with admin or order callbacks', () => {
  const { CALLBACKS } = require('../src/config/constants');
  const prefix = USER_CALLBACKS.ORDERS_PAGE_PREFIX;

  for (const existing of Object.values(CALLBACKS)) {
    assert.ok(
      !prefix.startsWith(existing) && !existing.startsWith(prefix),
      `/orders prefix "${prefix}" collides with "${existing}"`
    );
  }
});
