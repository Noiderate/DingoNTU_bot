const test = require('node:test');
const assert = require('node:assert/strict');
const { planMenuImport } = require('../src/services/menuImport');

/**
 * The one-time copy of the FoodAndStock tab into menu_items. A wrong price or a
 * dropped item here goes straight onto the menu customers pay from.
 */

test('items are imported in sheet order with prices as cents and stock as the opening baseline', () => {
  const { rows, warnings } = planMenuImport([
    { id: 2, name: 'Chicken Rice', price: 2.5, stock: 20 },
    { id: 3, name: 'Iced Milo', price: 1.99, stock: 0 },
  ]);

  assert.deepEqual(rows, [
    { name: 'Chicken Rice', price_cents: 250, stock: 20, baseline_stock: 20 },
    { name: 'Iced Milo', price_cents: 199, stock: 0, baseline_stock: 0 },
  ]);
  assert.deepEqual(warnings, []);
});

test('a price like 5.99 is rounded to 599 cents, not truncated to 598', () => {
  const { rows } = planMenuImport([{ name: 'Burger', price: 5.99, stock: 1 }]);

  assert.equal(rows[0].price_cents, 599);
});

test('a duplicate name (ignoring case) keeps the first and reports the rest', () => {
  const { rows, warnings } = planMenuImport([
    { name: 'Chicken Rice', price: 2.5, stock: 5 },
    { name: 'chicken rice', price: 9, stock: 9 },
  ]);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].price_cents, 250);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /duplicate/i);
});

test('an unreadable price is skipped and reported, never imported as free', () => {
  const { rows, warnings } = planMenuImport([
    { name: 'Mystery', price: 'abc', stock: 5 },
    { name: 'Negative', price: -1, stock: 5 },
    { name: 'Fine', price: 3, stock: 5 },
  ]);

  assert.deepEqual(rows.map(row => row.name), ['Fine']);
  assert.equal(warnings.length, 2);
});

test('stock is rounded to a whole, non-negative number', () => {
  const { rows } = planMenuImport([
    { name: 'A', price: 1, stock: 4.6 },
    { name: 'B', price: 1, stock: -3 },
    { name: 'C', price: 1, stock: undefined },
  ]);

  assert.deepEqual(rows.map(row => row.stock), [5, 0, 0]);
});

test('names are trimmed and a blank name is dropped quietly', () => {
  const { rows, warnings } = planMenuImport([
    { name: '  Chicken Rice  ', price: 2.5, stock: 1 },
    { name: '   ', price: 1, stock: 1 },
  ]);

  assert.deepEqual(rows.map(row => row.name), ['Chicken Rice']);
  assert.deepEqual(warnings, []);
});

test('an empty sheet imports nothing', () => {
  assert.deepEqual(planMenuImport([]), { rows: [], warnings: [] });
});
