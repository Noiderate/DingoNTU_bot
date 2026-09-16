const test = require('node:test');
const assert = require('node:assert/strict');

const { cartEntries, getQuantity, isEmpty, findCartMismatch, emptyCart } = require('../src/services/cartStore');

/**
 * The guard against spreadsheet rows shifting under an open cart.
 *
 * An item's id IS its FoodAndStock row number, so deleting or sorting rows
 * renumbers everything below. Without the name snapshot, a cart holding
 * "row 2" would silently be charged for whatever food moved into row 2.
 */

function cartWith(items) {
  return { ...emptyCart(), hallName: 'Eusoff Hall', items };
}

const CART = cartWith({
  2: { quantity: 2, name: 'Chicken Rice' },
  5: { quantity: 1, name: 'Iced Milo' },
});

const LIVE_ITEMS = [
  { id: 2, name: 'Chicken Rice', price: 6.5, stock: 10 },
  { id: 5, name: 'Iced Milo', price: 3, stock: 10 },
];

test('cart entries carry the quantity and the recorded name', () => {
  assert.deepEqual(cartEntries(CART), [
    { foodId: 2, quantity: 2, name: 'Chicken Rice' },
    { foodId: 5, quantity: 1, name: 'Iced Milo' },
  ]);
});

test('zero-quantity entries are ignored', () => {
  const entries = cartEntries(cartWith({ 2: { quantity: 0, name: 'Chicken Rice' } }));
  assert.deepEqual(entries, []);
  assert.equal(isEmpty(cartWith({ 2: { quantity: 0, name: 'x' } })), true);
});

test('getQuantity reads a single item', () => {
  assert.equal(getQuantity(CART, 2), 2);
  assert.equal(getQuantity(CART, 5), 1);
  assert.equal(getQuantity(CART, 99), 0);
  assert.equal(getQuantity(emptyCart(), 2), 0);
});

test('an unchanged menu passes', () => {
  assert.equal(findCartMismatch(cartEntries(CART), LIVE_ITEMS), null);
});

test('an empty cart passes', () => {
  assert.equal(findCartMismatch([], LIVE_ITEMS), null);
});

test('a row now holding different food is caught', () => {
  // Someone deleted a row above, so Iced Milo shifted up into row 2.
  const shifted = [
    { id: 2, name: 'Iced Milo', price: 3, stock: 10 },
    { id: 5, name: 'Nasi Lemak', price: 5, stock: 10 },
  ];

  const mismatch = findCartMismatch(cartEntries(CART), shifted);

  assert.ok(mismatch, 'expected the shift to be detected');
  assert.equal(mismatch.foodId, 2);
  assert.equal(mismatch.expected, 'Chicken Rice');
  assert.equal(mismatch.actual, 'Iced Milo');
});

test('a row that no longer exists is caught', () => {
  const mismatch = findCartMismatch(cartEntries(CART), [LIVE_ITEMS[0]]);

  assert.ok(mismatch);
  assert.equal(mismatch.foodId, 5);
  assert.equal(mismatch.expected, 'Iced Milo');
  assert.equal(mismatch.actual, null);
});

test('an emptied menu is caught rather than producing a free order', () => {
  const mismatch = findCartMismatch(cartEntries(CART), []);
  assert.ok(mismatch);
});

test('a renamed item is caught', () => {
  // Renaming is indistinguishable from a row shift, and refusing is the safe
  // reading: the customer chose the name they were shown.
  const renamed = [
    { id: 2, name: 'Chicken Rice (Large)', price: 7.5, stock: 10 },
    LIVE_ITEMS[1],
  ];

  const mismatch = findCartMismatch(cartEntries(CART), renamed);

  assert.ok(mismatch);
  assert.equal(mismatch.expected, 'Chicken Rice');
  assert.equal(mismatch.actual, 'Chicken Rice (Large)');
});

test('a price change alone does not invalidate the cart', () => {
  // Price is re-read at checkout, so the customer is charged correctly. Only
  // identity changes matter here.
  const repriced = [
    { id: 2, name: 'Chicken Rice', price: 9.9, stock: 10 },
    LIVE_ITEMS[1],
  ];

  assert.equal(findCartMismatch(cartEntries(CART), repriced), null);
});

test('the first mismatch is reported', () => {
  const allWrong = [
    { id: 2, name: 'Something Else', price: 1, stock: 10 },
    { id: 5, name: 'Another Thing', price: 1, stock: 10 },
  ];

  assert.equal(findCartMismatch(cartEntries(CART), allWrong).foodId, 2);
});
