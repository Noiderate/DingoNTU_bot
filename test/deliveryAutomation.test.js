const test = require('node:test');
const assert = require('node:assert/strict');

const googleSheets = require('../src/services/googleSheets');
const orderStore = require('../src/services/orderStore');
const cartStore = require('../src/services/cartStore');
const orderActions = require('../src/services/orderActions');
const stateStore = require('../src/services/stateStore');
const admin = require('../src/handlers/admin');

/**
 * Hall blocking is no longer a manual admin button - it, and the "get ready"
 * / "coming" channel posts that used to require a tap, are now driven off
 * each hall's serve progress (see admin.js: postDingoUpdate,
 * autoAdvanceDeliveryStage and friends). Only the "we are here" post stays
 * manual.
 */

test('meetsAutoPostThreshold: get-ready fires at 2/3 served, not before', () => {
  assert.equal(admin.meetsAutoPostThreshold('get-ready', 2 / 3), true);
  assert.equal(admin.meetsAutoPostThreshold('get-ready', 0.6), false);
  assert.equal(admin.meetsAutoPostThreshold('get-ready', 1), true);
});

test('meetsAutoPostThreshold: coming fires only once everything is served', () => {
  assert.equal(admin.meetsAutoPostThreshold('coming', 1), true);
  assert.equal(admin.meetsAutoPostThreshold('coming', 0.99), false);
});

test('meetsAutoPostThreshold: an unrecognised mode never fires (preorder/here stay manual)', () => {
  assert.equal(admin.meetsAutoPostThreshold('preorder', 1), false);
  assert.equal(admin.meetsAutoPostThreshold('here', 1), false);
});

test('a hall with zero servable orders is trivially "done" (fraction 1)', async t => {
  t.mock.method(require('../src/services/orderRepository'), 'getOrdersForHallServeProgress', async () => []);

  const progress = await orderStore.getHallServeProgress('Empty Hall');
  assert.deepEqual(progress, { total: 0, served: 0, fraction: 1 });
});


// --- notifyHallCustomers ------------------------------------------------------

test('notifyHallCustomers messages every distinct active order for that hall', async t => {
  t.mock.method(orderStore, 'getActiveOrdersByHall', async hallName => {
    assert.equal(hallName, 'Hall A');
    return [
      { chatId: 111 },
      { chatId: 222 },
      { chatId: 111 }, // same customer, a second active order - must not double-DM
    ];
  });

  const sent = [];
  t.mock.method(orderActions, 'notify', async (bot, chatId, text) => { sent.push({ chatId, text }); return true; });

  await admin.notifyHallCustomers({}, 'Hall A', 'get ready!');

  assert.equal(sent.length, 2);
  assert.deepEqual(new Set(sent.map(s => s.chatId)), new Set([111, 222]));
  assert.ok(sent.every(s => s.text === 'get ready!'));
});

test('notifyHallCustomers sends nothing when the hall has no active orders', async t => {
  t.mock.method(orderStore, 'getActiveOrdersByHall', async () => []);
  t.mock.method(orderActions, 'notify', async () => { throw new Error('should not be called'); });

  await assert.doesNotReject(admin.notifyHallCustomers({}, 'Empty Hall', 'x'));
});


// --- kickOpenCartsForHall ------------------------------------------------------

test('kickOpenCartsForHall clears every open cart for the hall and tells each customer', async t => {
  t.mock.method(cartStore, 'getCartsForHall', async hallName => {
    assert.equal(hallName, 'Hall A');
    return [111, 222];
  });

  const cleared = [];
  t.mock.method(cartStore, 'clearCart', async telegramUserId => { cleared.push(telegramUserId); });

  const notified = [];
  t.mock.method(orderActions, 'notify', async (bot, chatId, text) => { notified.push({ chatId, text }); return true; });

  await admin.kickOpenCartsForHall({}, 'Hall A');

  assert.deepEqual(cleared, [111, 222]);
  assert.equal(notified.length, 2);
  assert.ok(notified.every(n => /closed/i.test(n.text)));
});

test('kickOpenCartsForHall does nothing when nobody has an open cart there', async t => {
  t.mock.method(cartStore, 'getCartsForHall', async () => []);
  t.mock.method(cartStore, 'clearCart', async () => { throw new Error('should not be called'); });
  t.mock.method(orderActions, 'notify', async () => { throw new Error('should not be called'); });

  await assert.doesNotReject(admin.kickOpenCartsForHall({}, 'Hall A'));
});


// --- blockHallForAutoClosure ---------------------------------------------------

test('blockHallForAutoClosure blocks the hall and kicks open carts when newly blocked', async t => {
  t.mock.method(orderStore, 'blockHall', async hallName => {
    assert.equal(hallName, 'Hall A');
    return true;
  });

  let kicked = false;
  t.mock.method(cartStore, 'getCartsForHall', async () => { kicked = true; return [111]; });
  t.mock.method(cartStore, 'clearCart', async () => {});
  t.mock.method(orderActions, 'notify', async () => true);
  // refreshPreorderPost short-circuits on "no post yet" without touching
  // getHalls/Supabase - this is what getPreorderPost's stateStore.get falls
  // back to.
  t.mock.method(stateStore, 'get', async (key, fallback = null) => fallback);

  await admin.blockHallForAutoClosure({}, { name: 'Hall A' });

  assert.ok(kicked);
});

test('blockHallForAutoClosure is a no-op when the hall is already blocked', async t => {
  t.mock.method(orderStore, 'blockHall', async () => false);
  t.mock.method(cartStore, 'getCartsForHall', async () => { throw new Error('should not be called'); });

  await assert.doesNotReject(admin.blockHallForAutoClosure({}, { name: 'Hall A' }));
});


// --- autoAdvanceDeliveryStage: safety guards -----------------------------------

const HALLS = [
  { id: 1, name: 'Hall A' },
  { id: 2, name: 'Hall B' },
  { id: 3, name: 'Hall C' },
];

test('autoAdvanceDeliveryStage does nothing for a hall not in the current hall list', async t => {
  t.mock.method(googleSheets, 'getHalls', async () => HALLS);
  t.mock.method(orderStore, 'getHallServeProgress', async () => { throw new Error('should not be reached'); });

  await assert.doesNotReject(admin.autoAdvanceDeliveryStage({}, 'Unknown Hall'));
});

test('autoAdvanceDeliveryStage never advances off the last hall (the sequencer wraparound guard)', async t => {
  t.mock.method(googleSheets, 'getHalls', async () => HALLS);
  t.mock.method(orderStore, 'getHallServeProgress', async () => { throw new Error('should not be reached'); });

  // Hall C is last in the list - its own progress must never re-trigger
  // Hall A's get-ready/coming a second time.
  await assert.doesNotReject(admin.autoAdvanceDeliveryStage({}, 'Hall C'));
});

test('autoAdvanceDeliveryStage does nothing while the sequencer is not waiting on an automatic stage', async t => {
  t.mock.method(googleSheets, 'getHalls', async () => HALLS);
  t.mock.method(orderStore, 'getHallServeProgress', async () => ({ total: 3, served: 3, fraction: 1 }));
  // Default sequencer state (mode: 'preorder') falls out of every stateStore
  // read via its fallback - meetsAutoPostThreshold('preorder', ...) is
  // always false, so the loop must return without posting anything.
  t.mock.method(stateStore, 'get', async (key, fallback = null) => fallback);

  await assert.doesNotReject(admin.autoAdvanceDeliveryStage({}, 'Hall A'));
});
