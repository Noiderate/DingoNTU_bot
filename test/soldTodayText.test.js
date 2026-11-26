const test = require('node:test');
const assert = require('node:assert/strict');
const { soldTodayText } = require('../src/utils/menuTexts');

/**
 * 🧾 Sold Today shows starting stock, sold and left per item, from the same
 * figures as the Stock table in the Today's Orders tab.
 */

test('each item shows start, sold and left, with totals', () => {
  const text = soldTodayText([
    { name: 'Chicken Rice', starting: 41, remaining: 31, sold: 10 },
    { name: 'Fries', starting: 20, remaining: 20, sold: 0 },
  ]);

  assert.match(text, /Chicken Rice\n {3}Start 41 · Sold 10 · Left 31/);
  assert.match(text, /Fries\n {3}Start 20 · Sold 0 · Left 20/);
  assert.match(text, /Total sold: 10 · Total left: 51/);
});

test('an empty menu says so', () => {
  assert.match(soldTodayText([]), /No food items on the menu yet/);
});
