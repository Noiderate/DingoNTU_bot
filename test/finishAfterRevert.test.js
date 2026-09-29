const test = require('node:test');
const assert = require('node:assert/strict');
const googleSheets = require('../src/services/googleSheets');
const menuStore = require('../src/services/menuStore');
const stateStore = require('../src/services/stateStore');
const orderStore = require('../src/services/orderStore');
const { getDeliveryModeView } = require('../src/handlers/deliveryMode');
const { CALLBACKS } = require('../src/config/constants');

/**
 * Reverting the last blocked hall after the round has ended used to hide
 * Finish Delivery (it required every hall blocked), while the wrapped-around
 * get-ready has no button and never auto-posts - leaving the admin stuck.
 */

const HALLS = [
  { id: 2, name: 'Hall A' },
  { id: 3, name: 'Hall B' },
  { id: 4, name: 'Hall C' },
];

function mockView(t, { sequencer, blocked }) {
  t.mock.method(googleSheets, 'getHalls', async () => HALLS);
  t.mock.method(menuStore, 'getFoodItems', async () => []);
  t.mock.method(orderStore, 'getActiveOrders', async () => []);
  t.mock.method(orderStore, 'getHallServeProgress', async () => ({ total: 0, served: 0, fraction: 1 }));
  t.mock.method(orderStore, 'loadBlockedHalls', async () => ({
    isBlocked: name => blocked.includes(name),
    names: blocked,
    last: blocked[blocked.length - 1] || null,
  }));
  t.mock.method(stateStore, 'get', async (key, fallback = null) => (
    key === stateStore.KEYS.deliverySequencer() ? sequencer : fallback
  ));
}

const hasFinish = keyboard => keyboard.inline_keyboard
  .some(row => row.some(button => button.callback_data === CALLBACKS.DELIVERY_MODE_FINISH));

test('Finish Delivery stays available after reverting a hall once the round is over', async t => {
  // Last hall's "here" posted: sequencer wrapped to the first hall's get-ready.
  mockView(t, { sequencer: { index: 0, mode: 'get-ready' }, blocked: ['Hall A', 'Hall B'] });

  const { keyboard } = await getDeliveryModeView();

  assert.ok(hasFinish(keyboard));
});

test('Finish Delivery is not offered mid-round just because a hall was reverted', async t => {
  mockView(t, { sequencer: { index: 1, mode: 'here' }, blocked: ['Hall A'] });

  const { keyboard } = await getDeliveryModeView();

  assert.equal(hasFinish(keyboard), false);
});

test('Finish Delivery is still offered when every hall is blocked', async t => {
  mockView(t, { sequencer: { index: 2, mode: 'here' }, blocked: ['Hall A', 'Hall B', 'Hall C'] });

  const { keyboard } = await getDeliveryModeView();

  assert.ok(hasFinish(keyboard));
});
