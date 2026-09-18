const test = require('node:test');
const assert = require('node:assert/strict');

const admin = require('../src/handlers/admin');
const googleSheets = require('../src/services/googleSheets');
const stateStore = require('../src/services/stateStore');
const orderStore = require('../src/services/orderStore');

/**
 * /skip: a manual override that force-posts whatever the sequencer has
 * queued next (get-ready, coming, or here), regardless of serve progress -
 * the recovery path for when the automatic get-ready/coming trigger can't
 * or didn't fire. Goes through the same postDingoUpdate every other post
 * uses, so it's still lock-safe and still runs the block/notify hooks.
 */

const HALLS = [
  { id: 1, name: 'Hall A' },
  { id: 2, name: 'Hall B' },
];

test('handleSkipCommand says so when nothing is queued', async t => {
  t.mock.method(googleSheets, 'getHalls', async () => []);

  const sent = [];
  const bot = { async sendMessage(chatId, text) { sent.push({ chatId, text }); } };

  await admin.handleSkipCommand(bot, 555, 42);

  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /nothing queued/i);
});

test('handleSkipCommand force-posts the queued get-ready even though nobody has been served yet', async t => {
  t.mock.method(googleSheets, 'getHalls', async () => HALLS);
  t.mock.method(googleSheets, 'getPreorderAdminTag', async () => null);
  // Sequencer sitting at {index: 1, mode: 'get-ready'} (Hall B is next).
  t.mock.method(stateStore, 'get', async (key, fallback = null) => (
    key === stateStore.KEYS.deliverySequencer() ? { index: 1, mode: 'get-ready' } : fallback
  ));
  t.mock.method(stateStore, 'set', async () => {});
  t.mock.method(stateStore, 'acquireLock', async () => 'holder-1');
  t.mock.method(stateStore, 'releaseLock', async () => true);
  t.mock.method(orderStore, 'getActiveOrdersByHall', async () => []);

  const channelMessages = [];
  const adminMessages = [];
  const bot = {
    async sendMessage(chatId, text) {
      if (chatId === 555) adminMessages.push(text);
      else channelMessages.push({ chatId, text });
      return { message_id: 1 };
    },
  };

  await admin.handleSkipCommand(bot, 555, 42);

  assert.equal(channelMessages.length, 1);
  assert.match(channelMessages[0].text, /Get ready, Hall B/);
  assert.match(adminMessages[adminMessages.length - 1], /Skipped ahead/);
});

test('handleSkipCommand reports a clear reason when the post fails, instead of a silent no-op', async t => {
  t.mock.method(googleSheets, 'getHalls', async () => HALLS);
  t.mock.method(stateStore, 'get', async (key, fallback = null) => (
    key === stateStore.KEYS.deliverySequencer() ? { index: 1, mode: 'get-ready' } : fallback
  ));
  t.mock.method(stateStore, 'acquireLock', async () => null); // someone else holds it

  const sent = [];
  const bot = { async sendMessage(chatId, text) { sent.push(text); } };

  await admin.handleSkipCommand(bot, 555, 42);

  assert.equal(sent.length, 1);
  assert.match(sent[0], /already being posted/i);
});

test('handleSkipCommand on a "here" skip still cascades through get-ready/coming for a hall nobody ordered from', async t => {
  t.mock.method(googleSheets, 'getHalls', async () => HALLS);
  t.mock.method(googleSheets, 'getPreorderAdminTag', async () => null);
  t.mock.method(stateStore, 'acquireLock', async () => 'holder-1');
  t.mock.method(stateStore, 'releaseLock', async () => true);
  t.mock.method(stateStore, 'set', async () => {});
  t.mock.method(orderStore, 'getActiveOrdersByHall', async () => []);
  t.mock.method(orderStore, 'getHallServeProgress', async () => ({ total: 0, served: 0, fraction: 1 }));
  t.mock.method(orderStore, 'blockHall', async () => true);
  t.mock.method(orderStore, 'loadBlockedHalls', async () => ({ isBlocked: () => false }));

  // Sequencer starts at {index: 0, mode: 'here'} for Hall A, and actually
  // advances as each postDingoUpdate call runs (real setSequencer logic
  // driven through a tiny in-memory stand-in, since the cascade depends on
  // reading back what the previous step just wrote).
  let sequencer = { index: 0, mode: 'here' };
  t.mock.method(stateStore, 'get', async (key, fallback = null) => (
    key === stateStore.KEYS.deliverySequencer() ? sequencer : fallback
  ));
  const originalSet = stateStore.set;
  t.mock.method(stateStore, 'set', async (key, value) => {
    if (key === stateStore.KEYS.deliverySequencer()) sequencer = value;
  });

  const channelMessages = [];
  const bot = {
    async sendMessage(chatId, text) {
      if (chatId !== 555) channelMessages.push(text);
      return { message_id: 1 };
    },
  };

  await admin.handleSkipCommand(bot, 555, 42);

  // "Hall A, we are here" (the skip itself), then the auto-cascade for
  // Hall B: "Get ready, Hall B" and its "coming" post.
  assert.equal(channelMessages.length, 3);
  assert.match(channelMessages[0], /Hall A, we are here/);
  assert.match(channelMessages[1], /Get ready, Hall B/);
  assert.ok(admin.blockHallForAutoClosure); // sanity: the hook exists and would have fired via 'coming'
});
