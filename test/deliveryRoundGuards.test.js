const test = require('node:test');
const assert = require('node:assert/strict');
const googleSheets = require('../src/services/googleSheets');
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

function mockSequencer(t, sequencer, { resetToken = null } = {}) {
  t.mock.method(stateStore, 'get', async (key, fallback = null) => {
    if (key === stateStore.KEYS.deliverySequencer()) return sequencer;
    if (key === stateStore.KEYS.resetToken()) return resetToken;
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

function mockView(t, { sequencer, orders = [], blocked = [], resetToken = null }) {
  t.mock.method(googleSheets, 'getHalls', async () => HALLS);
  t.mock.method(googleSheets, 'getFoodItems', async () => []);
  t.mock.method(orderStore, 'getActiveOrders', async () => orders);
  t.mock.method(orderStore, 'getHallServeProgress', async () => ({ total: 0, served: 0, fraction: 1 }));
  t.mock.method(orderStore, 'loadBlockedHalls', async () => ({
    isBlocked: name => blocked.includes(name),
    names: blocked,
    last: blocked[blocked.length - 1] || null,
  }));
  mockSequencer(t, sequencer, { resetToken });
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


// --- No preorder post until last round is reset --------------------------------

test('the preorder button is replaced by "Reset first" while Finish\'s reset is still outstanding', async t => {
  mockView(t, { sequencer: { index: 0, mode: 'preorder' }, resetToken: 'tok' });

  const { keyboard, text } = await getDeliveryModeView();

  assert.ok(callbacks(keyboard).includes(CALLBACKS.DELIVERY_MODE_RESET_FIRST));
  assert.ok(!callbacks(keyboard).some(data => data.startsWith(`${CALLBACKS.DELIVERY_MODE_POST_CHANNEL_PREFIX}preorder`)));
  assert.match(text, /hasn't been reset yet/);
});

test('the preorder button is replaced while any hall is still closed', async t => {
  mockView(t, { sequencer: { index: 0, mode: 'preorder' }, blocked: ['Hall A'] });

  const { keyboard } = await getDeliveryModeView();

  assert.ok(callbacks(keyboard).includes(CALLBACKS.DELIVERY_MODE_RESET_FIRST));
});

test('after a reset the preorder button is back', async t => {
  mockView(t, { sequencer: { index: 0, mode: 'preorder' } });

  const { keyboard } = await getDeliveryModeView();

  assert.ok(callbacks(keyboard).includes(`${CALLBACKS.DELIVERY_MODE_POST_CHANNEL_PREFIX}preorder:2`));
  assert.ok(!callbacks(keyboard).includes(CALLBACKS.DELIVERY_MODE_RESET_FIRST));
});

test('an old preorder button (or /skip) is refused server-side until the reset runs', async t => {
  t.mock.method(googleSheets, 'getHalls', async () => HALLS);
  mockSequencer(t, { index: 0, mode: 'preorder' }, { resetToken: 'tok' });
  t.mock.method(orderStore, 'loadBlockedHalls', async () => ({ isBlocked: () => false, names: [], last: null }));
  t.mock.method(stateStore, 'acquireLock', async () => 'holder');
  t.mock.method(stateStore, 'releaseLock', async () => true);
  t.mock.method(stateStore, 'getMany', async () => ({}));

  const bot = { async sendMessage() { throw new Error('must not post the preorder'); } };

  const result = await admin.postDingoUpdate(bot, { hallId: 2, postMode: 'preorder' });

  assert.deepEqual(result, { posted: false, reason: 'reset_required' });
});

test('"Reset first" reuses Finish\'s token so both reset buttons stay valid', async t => {
  mockSequencer(t, { index: 0, mode: 'preorder' }, { resetToken: 'tok' });
  t.mock.method(stateStore, 'set', async () => { throw new Error('must not issue a second token'); });

  const sent = [];
  const bot = { async sendMessage(chatId, text, opts) { sent.push(opts); } };

  await admin.handleResetFirst(bot, 555, async () => {});

  assert.equal(sent[0].reply_markup.inline_keyboard[0][0].callback_data, `${CALLBACKS.DELIVERY_MODE_RESET_HALLS}:tok`);
});
