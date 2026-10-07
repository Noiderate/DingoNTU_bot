const test = require('node:test');
const assert = require('node:assert/strict');
const googleSheets = require('../src/services/googleSheets');
const menuStore = require('../src/services/menuStore');
const stateStore = require('../src/services/stateStore');
const orderStore = require('../src/services/orderStore');
const admin = require('../src/handlers/admin');
const { visitedHalls, getDeliveryModeView } = require('../src/handlers/deliveryMode');
const { CALLBACKS } = require('../src/config/constants');

const HALLS = [
  { id: 2, name: 'Hall A' },
  { id: 3, name: 'Hall B' },
  { id: 4, name: 'Hall C' },
];

function mockSequencer(t, sequencer) {
  t.mock.method(stateStore, 'get', async (key, fallback = null) => {
    if (key === stateStore.KEYS.deliverySequencer()) return sequencer;
    return fallback;
  });
}

const callbacks = keyboard => keyboard.inline_keyboard.flat().map(button => button.callback_data);


// --- Auto-advance only follows the hall it is gated on -------------------------

test('serving an order at an earlier hall does not fire the current hall\'s automatic posts', async t => {
  t.mock.method(googleSheets, 'getHalls', async () => HALLS);
  // Delivery is at Hall B (its "here" posted), waiting on B's progress to post
  // "Get ready, Hall C". Hall A - reverted, say - is fully served.
  mockSequencer(t, { index: 2, mode: 'get-ready' });
  t.mock.method(orderStore, 'getHallServeProgress', async () => ({ total: 1, served: 1, fraction: 1 }));
  t.mock.method(stateStore, 'acquireLock', async () => {
    throw new Error('must not post anything for Hall A\'s progress');
  });

  await assert.doesNotReject(admin.autoAdvanceDeliveryStage({}, 'Hall A'));
});

test('serving at the gating hall still fires its automatic post', async t => {
  t.mock.method(googleSheets, 'getHalls', async () => HALLS);
  mockSequencer(t, { index: 2, mode: 'get-ready' });
  t.mock.method(orderStore, 'getHallServeProgress', async () => ({ total: 3, served: 3, fraction: 1 }));

  let attempted = false;
  t.mock.method(stateStore, 'acquireLock', async () => { attempted = true; return null; }); // "locked" - stop there

  await admin.autoAdvanceDeliveryStage({}, 'Hall B');

  assert.equal(attempted, true);
});


// --- Serve lists for halls already visited -------------------------------------

test('visitedHalls: the halls whose "we are here" has already posted this round', () => {
  assert.deepEqual(visitedHalls(HALLS, { index: 0, mode: 'preorder' }), []);
  assert.deepEqual(visitedHalls(HALLS, { index: 0, mode: 'coming' }), []); // first hall not reached yet
  assert.deepEqual(visitedHalls(HALLS, { index: 0, mode: 'here' }), []);
  assert.deepEqual(visitedHalls(HALLS, { index: 2, mode: 'get-ready' }).map(hall => hall.name), ['Hall A', 'Hall B']);
  assert.deepEqual(visitedHalls(HALLS, { index: 1, mode: 'here' }).map(hall => hall.name), ['Hall A']);
  // Wrapped round: every hall has been visited.
  assert.deepEqual(visitedHalls(HALLS, { index: 0, mode: 'get-ready' }).length, 3);
});

function mockView(t, { sequencer, orders = [], blocked = [] }) {
  t.mock.method(googleSheets, 'getHalls', async () => HALLS);
  t.mock.method(menuStore, 'getFoodItems', async () => []);
  t.mock.method(orderStore, 'getActiveOrders', async () => orders);
  t.mock.method(orderStore, 'getHallServeProgress', async () => ({ total: 0, served: 0, fraction: 1 }));
  t.mock.method(orderStore, 'loadBlockedHalls', async () => ({
    isBlocked: name => blocked.includes(name),
    names: blocked,
    last: blocked[blocked.length - 1] || null,
  }));
  mockSequencer(t, sequencer);
}

test('the delivery menu offers a serve list for a visited hall that still has unserved orders', async t => {
  mockView(t, {
    sequencer: { index: 2, mode: 'get-ready' },
    orders: [{ hallName: 'Hall A', status: 'paid', items: [] }, { hallName: 'Hall C', status: 'paid', items: [] }],
  });

  const { keyboard } = await getDeliveryModeView();

  const serveLists = callbacks(keyboard).filter(data => data.startsWith(CALLBACKS.DELIVERY_MODE_SERVE_LIST_PREFIX));
  // Hall A (visited, 1 order) - not Hall B (no orders) nor Hall C (not reached).
  assert.deepEqual(serveLists, [`${CALLBACKS.DELIVERY_MODE_SERVE_LIST_PREFIX}Hall A`]);
});

test('the serve list button resends the hall\'s list without posting to the channel', async t => {
  t.mock.method(orderStore, 'getActiveOrdersByHall', async () => [
    { id: 'o1', code: 'DG1', userId: 7, phoneNumber: '91234567', items: [{ name: 'Milo', quantity: 1 }] },
  ]);
  const stored = [];
  t.mock.method(stateStore, 'get', async (key, fallback = null) => (
    key === stateStore.KEYS.hallServeMessage('Hall A') ? { chatId: 555, messageId: 40 } : fallback
  ));
  t.mock.method(stateStore, 'set', async (key, value) => { stored.push({ key, value }); });

  const sent = [];
  const deleted = [];
  const bot = {
    async sendMessage(chatId, text, opts) { sent.push({ chatId, text, opts }); return { message_id: 41 }; },
    async deleteMessage(chatId, messageId) { deleted.push(messageId); },
  };

  await admin.handleServeListResend(bot, 555, 'Hall A', async () => {});

  assert.equal(sent.length, 1);
  assert.equal(sent[0].chatId, 555); // the admin's chat, never the channel
  assert.match(sent[0].text, /Hall A, we are here/);
  assert.deepEqual(deleted, [40]); // the older copy is replaced
  const tracked = stored.find(entry => entry.key === stateStore.KEYS.hallServeMessage('Hall A'));
  assert.deepEqual(tracked.value, { chatId: 555, messageId: 41 });
});


// --- The preorder post resets last round automatically ----------------------

test('the preorder button is always offered, even with a hall still closed', async t => {
  mockView(t, { sequencer: { index: 0, mode: 'preorder' }, blocked: ['Hall A'] });

  const { keyboard } = await getDeliveryModeView();

  assert.ok(callbacks(keyboard).includes(`${CALLBACKS.DELIVERY_MODE_POST_CHANNEL_PREFIX}preorder:2`));
  assert.ok(!callbacks(keyboard).includes(CALLBACKS.DELIVERY_MODE_RESET_FIRST));
});

function mockRoundReset(t, { leftover = [], servedUnpaid = [] } = {}) {
  const calls = [];
  t.mock.method(orderStore, 'getActiveOrders', async () => leftover);
  t.mock.method(orderStore, 'getRecentServedUnpaidOrders', async () => servedUnpaid);
  t.mock.method(menuStore, 'restoreStockBaselines', async () => { calls.push('stock'); return { changes: [], noBaselineItems: [] }; });
  t.mock.method(orderStore, 'clearBlockedHalls', async () => { calls.push('unblock'); });
  t.mock.method(orderStore, 'loadBlockedHalls', async () => ({ isBlocked: () => false, names: [], last: null }));
  t.mock.method(stateStore, 'set', async () => {});
  t.mock.method(stateStore, 'remove', async () => {});
  t.mock.method(stateStore, 'acquireLock', async () => 'holder');
  t.mock.method(stateStore, 'releaseLock', async () => true);
  t.mock.method(stateStore, 'getMany', async () => ({}));
  return calls;
}

test('runRoundReset restores stock, reopens halls and summarises served-but-unpaid orders', async t => {
  t.mock.method(googleSheets, 'getHalls', async () => HALLS);
  mockSequencer(t, { index: 2, mode: 'get-ready' });
  const calls = mockRoundReset(t, {
    servedUnpaid: [{ code: 'DG9', hallName: 'Hall B', userName: 'Ali', username: 'ali', items: [] }],
  });

  const summary = await admin.runRoundReset({});

  assert.deepEqual(calls, ['stock', 'unblock']);
  assert.match(summary, /were reset for the new round/);
  assert.match(summary, /Served but never paid/);
  assert.match(summary, /DG9/);
});

test('resetRoundBeforePreorder resets first and sends the summary to the triggering admin', async t => {
  t.mock.method(googleSheets, 'getHalls', async () => HALLS);
  mockSequencer(t, { index: 0, mode: 'preorder' });
  const calls = mockRoundReset(t);

  const sent = [];
  const bot = { async sendMessage(chatId, text) { sent.push({ chatId, text, calls: [...calls] }); } };

  await admin.resetRoundBeforePreorder(bot, 555);

  assert.equal(sent.length, 1);
  assert.equal(sent[0].chatId, 555);
  assert.match(sent[0].text, /were reset for the new round/);
  assert.deepEqual(sent[0].calls, ['stock', 'unblock']);
});

test('posting the preorder no longer refuses when last round was never reset', async t => {
  t.mock.method(googleSheets, 'getHalls', async () => HALLS);
  mockSequencer(t, { index: 0, mode: 'preorder' });
  mockRoundReset(t);

  const bot = { async sendMessage() { throw new Error('reached the channel send'); } };

  const result = await admin.postDingoUpdate(bot, { hallId: 2, postMode: 'preorder' });

  assert.notEqual(result.reason, 'reset_required');
});
