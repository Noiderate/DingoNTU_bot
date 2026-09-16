const test = require('node:test');
const assert = require('node:assert/strict');

const { toCents, parseDisplayedAmount, formatCents, centsToDecimalString } = require('../src/utils/money');

test('toCents rounds rather than truncating float error', () => {
  // 5.99 * 100 is 598.9999999999999 in IEEE-754. Truncating would bill $5.98.
  assert.equal(toCents(5.99), 599);
  assert.equal(toCents(0.07), 7);
  assert.equal(toCents(0.29), 29);
  assert.equal(toCents('12.50'), 1250);
  assert.equal(toCents(0), 0);
});

test('prices finer than a cent are rounded to the nearest cent', () => {
  // Prices in FoodAndStock are two-decimal by definition, so this only ever
  // sees mistyped input. It rounds to the nearest cent rather than rejecting,
  // and exact half-cent values follow the float representation: 1.005 is
  // actually stored as slightly less than 1.005, so it rounds down.
  assert.equal(toCents(5.999), 600);
  assert.equal(toCents(1.005), 100);
});

test('toCents refuses values it cannot trust', () => {
  assert.equal(toCents('abc'), null);
  assert.equal(toCents(null), null);
  assert.equal(toCents(undefined), null);
  assert.equal(toCents(''), null);
  assert.equal(toCents(-5), null);
});

test('parseDisplayedAmount handles the formats Singapore banks render', () => {
  assert.equal(parseDisplayedAmount('S$12.50').cents, 1250);
  assert.equal(parseDisplayedAmount('SGD 1,234.50').cents, 123450);
  assert.equal(parseDisplayedAmount('$8').cents, 800);
  assert.equal(parseDisplayedAmount('12.50 SGD').cents, 1250);
  assert.equal(parseDisplayedAmount('S$1,000,000.00').cents, 100000000);
});

test('parseDisplayedAmount reports the currency it saw', () => {
  assert.equal(parseDisplayedAmount('S$12.50').currency, 'SGD');
  assert.equal(parseDisplayedAmount('SGD 12.50').currency, 'SGD');
  assert.equal(parseDisplayedAmount('RM 12.50').currency, 'MYR');
  // A bare number carries no currency claim.
  assert.equal(parseDisplayedAmount('12.50').currency, null);
});

test('parseDisplayedAmount rejects rather than guesses at bad OCR', () => {
  // A letter O read for a zero must not silently become a number.
  assert.equal(parseDisplayedAmount('12.5O').cents, null);
  assert.equal(parseDisplayedAmount('~12.50').cents, null);
  assert.equal(parseDisplayedAmount('12.505').cents, null);
  assert.equal(parseDisplayedAmount('').cents, null);
  assert.equal(parseDisplayedAmount(null).cents, null);
});

test('parseDisplayedAmount rejects zero and negative amounts', () => {
  assert.equal(parseDisplayedAmount('$0.00').cents, null);
  assert.equal(parseDisplayedAmount('-$5.00').cents, null);
});

test('formatting round-trips', () => {
  assert.equal(formatCents(1250), '$12.50');
  assert.equal(formatCents(0), '$0.00');
  assert.equal(formatCents(123450), '$1234.50');
  assert.equal(centsToDecimalString(1250), '12.50');
  assert.equal(centsToDecimalString(5), '0.05');
});
