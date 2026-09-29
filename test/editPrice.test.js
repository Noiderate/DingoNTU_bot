const test = require('node:test');
const assert = require('node:assert/strict');
const supabaseService = require('../src/services/supabase');
const menuStore = require('../src/services/menuStore');
const keyboards = require('../src/utils/keyboards');
const menuTexts = require('../src/utils/menuTexts');
const { CALLBACKS, STATES } = require('../src/config/constants');
const { parsePriceInput } = require('../src/utils/money');

/**
 * Admins change a menu price through the bot (Settings > Manage Food Items >
 * Edit Price). The number they type goes straight onto what customers pay, so
 * reading it is strict, and a change touches nothing but the price.
 */

// --- Reading what the admin typed ----------------------------------------------

test('parsePriceInput accepts plain, dollar-prefixed and comma-grouped prices', () => {
  assert.equal(parsePriceInput('5.99'), 5.99);
  assert.equal(parsePriceInput('$5.99'), 5.99);
  assert.equal(parsePriceInput('$ 5.99'), 5.99);
  assert.equal(parsePriceInput('  6  '), 6);
  assert.equal(parsePriceInput('3.5'), 3.5);
  assert.equal(parsePriceInput('1,250.50'), 1250.5);
  assert.equal(parsePriceInput('0.05'), 0.05);
});

test('parsePriceInput refuses anything that is not a positive price with at most 2 decimals', () => {
  for (const bad of ['', '   ', 'abc', '0', '0.00', '-3', '5.999', '5.', '.5', '1e3', '5,99,', '$', '12abc', 'NaN', 'Infinity']) {
    assert.equal(parsePriceInput(bad), null, `"${bad}" should be refused`);
  }
});

test('a comma-as-decimal price is refused, never read as hundreds of dollars', () => {
  // "5,99" must not become $599, and "1,25" must not become $125.
  for (const bad of ['5,99', '1,25', '12,5', '1250,50', '1,2345', ',500', '1,,000']) {
    assert.equal(parsePriceInput(bad), null, `"${bad}" should be refused`);
  }
  // Proper thousands grouping still works.
  assert.equal(parsePriceInput('1,000'), 1000);
  assert.equal(parsePriceInput('12,345.67'), 12345.67);
});

test('parsePriceInput copes with non-string input', () => {
  assert.equal(parsePriceInput(null), null);
  assert.equal(parsePriceInput(undefined), null);
});

test('a price that parsePriceInput accepts survives the cents conversion exactly', () => {
  const { toCents } = require('../src/utils/money');
  for (const text of ['5.99', '0.07', '19.99', '1250.50', '2.3', '4.35']) {
    const cents = toCents(parsePriceInput(text));
    assert.equal(cents, Math.round(Number(text) * 100), `${text} -> ${cents}`);
  }
});

// --- The store -----------------------------------------------------------------

/** Enough of a supabase-js builder for menuStore.updateFoodItemPrice. */
function fakeClient(result) {
  const calls = [];
  const chain = {};
  for (const method of ['update', 'eq', 'select']) {
    chain[method] = (...args) => {
      calls.push({ method, args });
      return chain;
    };
  }
  chain.then = (resolve, reject) => Promise.resolve(result).then(resolve, reject);
  return { calls, from: () => chain };
}

test('updateFoodItemPrice changes only the price, stored as whole cents', async t => {
  const client = fakeClient({ data: [{ name: 'Chicken Rice' }], error: null });
  t.mock.method(supabaseService, 'getSupabase', () => client);

  const result = await menuStore.updateFoodItemPrice(3, 5.99);

  assert.equal(result.success, true);
  assert.match(result.message, /Chicken Rice.*\$5\.99/);
  // 5.99 * 100 is 598.9999999999999 in floating point: truncating would bill $5.98.
  assert.deepEqual(client.calls.find(call => call.method === 'update').args[0], { price_cents: 599 });
  assert.deepEqual(client.calls.find(call => call.method === 'eq').args, ['id', 3]);
});

test('updateFoodItemPrice never touches stock or the reset baseline', async t => {
  const client = fakeClient({ data: [{ name: 'Chicken Rice' }], error: null });
  t.mock.method(supabaseService, 'getSupabase', () => client);

  await menuStore.updateFoodItemPrice(3, 4);

  const written = client.calls.find(call => call.method === 'update').args[0];
  assert.deepEqual(Object.keys(written), ['price_cents']);
});

test('updateFoodItemPrice refuses a bad price without asking the database', async t => {
  const client = fakeClient({ data: [], error: null });
  t.mock.method(supabaseService, 'getSupabase', () => client);

  for (const bad of ['abc', -1, null, '']) {
    assert.equal((await menuStore.updateFoodItemPrice(3, bad)).success, false);
  }
  assert.equal(client.calls.length, 0);
});

test('updateFoodItemPrice says so when the item was deleted meanwhile', async t => {
  t.mock.method(supabaseService, 'getSupabase', () => fakeClient({ data: [], error: null }));

  const result = await menuStore.updateFoodItemPrice(3, 5);

  assert.equal(result.success, false);
  assert.match(result.message, /no longer exists/);
});

test('updateFoodItemPrice reports a database failure instead of throwing', async t => {
  t.mock.method(supabaseService, 'getSupabase', () => fakeClient({ data: null, error: { message: 'timeout' } }));
  t.mock.method(console, 'error', () => {});

  const result = await menuStore.updateFoodItemPrice(3, 5);

  assert.equal(result.success, false);
  assert.match(result.message, /timeout/);
});

// --- Buttons and wording -------------------------------------------------------

test('the Manage Food Items menu offers Edit Price', () => {
  const buttons = keyboards.manageFoodItemsKeyboard().inline_keyboard.flat();

  assert.ok(buttons.some(button => button.callback_data === CALLBACKS.FOOD_EDIT_PRICE && /Edit Price/.test(button.text)));
});

test('the Edit Price list shows each item with its price to the cent, plus Back', () => {
  const buttons = keyboards.foodItemsEditPriceKeyboard([
    { id: 1, name: 'Chicken Rice', price: 2.5, stock: 3 },
    { id: 2, name: 'Iced Milo', price: 1.99, stock: 0 },
  ]).inline_keyboard.flat();

  assert.deepEqual(buttons.map(button => [button.text, button.callback_data]), [
    ['Chicken Rice ($2.50)', `${CALLBACKS.FOOD_EDIT_PRICE_PREFIX}1`],
    ['Iced Milo ($1.99)', `${CALLBACKS.FOOD_EDIT_PRICE_PREFIX}2`],
    ['← Back', CALLBACKS.SETTINGS_MANAGE_FOODS],
  ]);
});

test('the price prompt names the item and its current price', () => {
  const text = menuTexts.editPricePromptText('Chicken Rice', 2.5);

  assert.match(text, /Chicken Rice/);
  assert.match(text, /Current price: \$2\.50/);
});

test('every callback id is unique and no id can be mistaken for another by prefix', () => {
  const values = Object.values(CALLBACKS);
  assert.equal(new Set(values).size, values.length, 'duplicate callback id');

  // A handler that matches by prefix must never swallow another handler's id.
  const prefixes = values.filter(value => value.endsWith('_'));
  for (const value of values) {
    for (const prefix of prefixes) {
      if (value !== prefix) {
        assert.ok(!value.startsWith(prefix), `"${value}" would be routed by prefix "${prefix}"`);
      }
    }
  }
});

test('the price-edit state has its own name', () => {
  const states = Object.values(STATES);
  assert.equal(new Set(states).size, states.length);
  assert.equal(STATES.EDIT_FOOD_PRICE, 'edit_food_price');
});
