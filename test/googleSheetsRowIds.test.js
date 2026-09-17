const test = require('node:test');
const assert = require('node:assert/strict');
const { parseFoodItemRows, parseHallRows } = require('../src/services/googleSheets');

/**
 * Regression coverage for a critical bug: the row id used to be computed
 * from the position AFTER filtering out blank rows, so a blank row anywhere
 * in the middle of the sheet shifted every later item's id by one. Stock
 * updates then silently wrote to the wrong physical row - one item's stock
 * would never actually decrement, while an unrelated row got corrupted.
 */

test('a blank row in the middle does not shift later items onto the wrong sheet row', () => {
  const values = [
    ['Chicken Rice', '5', '10'], // A2
    [],                          // A3 - blank
    ['Nasi Lemak', '4.5', '20'], // A4
  ];

  const items = parseFoodItemRows(values);

  assert.equal(items.length, 2);
  assert.deepEqual(items[0], { id: 2, name: 'Chicken Rice', price: 5, stock: 10 });
  // Must be row 4 (its real sheet row), not row 3 (its position after the
  // blank row was filtered out).
  assert.deepEqual(items[1], { id: 4, name: 'Nasi Lemak', price: 4.5, stock: 20 });
});

test('a blank row with no matching cells at all is treated the same way', () => {
  const values = [
    ['Item A', '1', '1'], // A2
    [undefined],          // A3 - blank
    [''],                 // A4 - blank
    ['Item B', '2', '2'], // A5
  ];

  const items = parseFoodItemRows(values);

  assert.equal(items.length, 2);
  assert.equal(items[0].id, 2);
  assert.equal(items[1].id, 5);
});

test('halls compute their row id the same way', () => {
  const values = [
    ['Hall A', 'A'],
    [],
    ['Hall B', 'B'],
  ];

  const halls = parseHallRows(values);

  assert.equal(halls.length, 2);
  assert.deepEqual(halls[0], { id: 2, name: 'Hall A', shortName: 'A' });
  assert.deepEqual(halls[1], { id: 4, name: 'Hall B', shortName: 'B' });
});

test('a hall with no short name falls back to its name', () => {
  const halls = parseHallRows([['Hall C']]);
  assert.deepEqual(halls[0], { id: 2, name: 'Hall C', shortName: 'Hall C' });
});
