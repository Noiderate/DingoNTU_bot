const test = require('node:test');
const assert = require('node:assert/strict');

const admin = require('../src/handlers/admin');
const stateStore = require('../src/services/stateStore');
const orderStore = require('../src/services/orderStore');
const googleSheets = require('../src/services/googleSheets');
const { config } = require('../src/config');

/**
 * When a stock change takes an item from having stock to having none, the
 * bot posts a distinct "sold out" announcement per item and replaces the
 * live preorder post with a fresh one (a plain edit doesn't notify channel
 * subscribers) - instead of the normal silent edit-in-place refresh every
 * other stock change gets. See admin.js: findNewlySoldOutItems,
 * announceSoldOut, repostPreorderAvailability, refreshPreorderPostAfterStockChange.
 */

test('findNewlySoldOutItems only reports items that crossed from having stock to none', () => {
  const changes = [
    { name: 'Chicken Rice', oldStock: 2, newStock: 0 }, // just sold out
    { name: 'Iced Milo', oldStock: 5, newStock: 3 },     // still has stock
    { name: 'Mala', oldStock: 0, newStock: 0 },          // was already sold out
    { name: 'Nasi Lemak', oldStock: 1, newStock: -1 },   // defensive: negative counts as sold out too
  ];

  assert.deepEqual(admin.findNewlySoldOutItems(changes), [
    { name: 'Chicken Rice', oldStock: 2, newStock: 0 },
    { name: 'Nasi Lemak', oldStock: 1, newStock: -1 },
  ]);
});

test('findNewlySoldOutItems handles an empty or missing batch', () => {
  assert.deepEqual(admin.findNewlySoldOutItems([]), []);
  assert.deepEqual(admin.findNewlySoldOutItems(undefined), []);
});

test('announceSoldOut posts one message per item to the Dingo channel', async t => {
  const sent = [];
  const bot = { async sendMessage(chatId, text) { sent.push({ chatId, text }); } };

  await admin.announceSoldOut(bot, [{ name: 'Chicken Rice' }, { name: 'Iced Milo' }]);

  assert.equal(sent.length, 2);
  assert.ok(sent.every(m => m.chatId === config.telegram.dingoChannelId));
  assert.match(sent[0].text, /Chicken Rice has been sold out/);
  assert.match(sent[1].text, /Iced Milo has been sold out/);
});

test('announceSoldOut keeps going even if one send fails', async t => {
  let calls = 0;
  const bot = {
    async sendMessage() {
      calls += 1;
      if (calls === 1) throw new Error('rate limited');
    },
  };

  await assert.doesNotReject(admin.announceSoldOut(bot, [{ name: 'A' }, { name: 'B' }]));
  assert.equal(calls, 2);
});

// refreshPreorderPostAfterStockChange calls refreshPreorderPost/announceSoldOut/
// repostPreorderAvailability as bare same-module function references, not
// through module.exports - so those can't be intercepted with t.mock.method
// the way a different module's functions can. These two tests instead drive
// it through its real dependencies and check what it actually did: edited
// the live post in place (no sold-out item), or deleted+resent it and
// posted a "sold out" announcement (a sold-out item).

test('refreshPreorderPostAfterStockChange falls back to the normal silent refresh when nothing sold out', async t => {
  t.mock.method(stateStore, 'get', async (key, fallback = null) => (
    key === stateStore.KEYS.preorderPost()
      ? { channelId: 'chan1', msgId: 111, contentHash: 'stale-hash' }
      : fallback
  ));
  t.mock.method(stateStore, 'set', async () => {});
  t.mock.method(googleSheets, 'getHalls', async () => [{ id: 1, name: 'Hall A' }]);
  t.mock.method(orderStore, 'loadBlockedHalls', async () => ({ isBlocked: () => false }));
  t.mock.method(googleSheets, 'getPreorderAdminTag', async () => null);

  const edited = [];
  const channelMessages = [];
  const bot = {
    async editMessageText(text, opts) { edited.push({ text, opts }); },
    async sendMessage(chatId, text) { channelMessages.push({ chatId, text }); },
    async deleteMessage() { throw new Error('should not delete - this is a silent edit, not a repost'); },
  };

  await admin.refreshPreorderPostAfterStockChange(bot, [{ name: 'Iced Milo', oldStock: 5, newStock: 3 }]);

  assert.equal(edited.length, 1);
  assert.equal(channelMessages.length, 0); // no "sold out" post
});

test('refreshPreorderPostAfterStockChange announces and reposts when something sold out', async t => {
  t.mock.method(stateStore, 'get', async (key, fallback = null) => (
    key === stateStore.KEYS.preorderPost()
      ? { channelId: 'chan1', msgId: 111, contentHash: 'stale-hash' }
      : fallback
  ));
  t.mock.method(stateStore, 'set', async () => {});
  t.mock.method(googleSheets, 'getHalls', async () => [{ id: 1, name: 'Hall A' }]);
  t.mock.method(orderStore, 'loadBlockedHalls', async () => ({ isBlocked: () => false }));
  t.mock.method(googleSheets, 'getPreorderAdminTag', async () => null);

  const channelMessages = [];
  const deleted = [];
  const bot = {
    async editMessageText() { throw new Error('should not silently edit - something sold out'); },
    async sendMessage(chatId, text) { channelMessages.push({ chatId, text }); return { message_id: 999 }; },
    async deleteMessage(chatId, msgId) { deleted.push({ chatId, msgId }); },
  };

  await admin.refreshPreorderPostAfterStockChange(bot, [{ name: 'Chicken Rice', oldStock: 1, newStock: 0 }]);

  // The "sold out" announcement, then the fresh availability post.
  assert.equal(channelMessages.length, 2);
  assert.match(channelMessages[0].text, /Chicken Rice has been sold out/);
  assert.deepEqual(deleted, [{ chatId: 'chan1', msgId: 111 }]);
});


// --- repostPreorderAvailability -------------------------------------------------

test('repostPreorderAvailability does nothing when there is no live preorder post', async t => {
  t.mock.method(stateStore, 'get', async (key, fallback = null) => fallback);

  const bot = { async sendMessage() { throw new Error('should not send'); } };
  await assert.doesNotReject(admin.repostPreorderAvailability(bot));
});

test('repostPreorderAvailability sends a fresh post then deletes the old one, and records the new message id', async t => {
  t.mock.method(stateStore, 'get', async (key, fallback = null) => (
    key === stateStore.KEYS.preorderPost()
      ? { channelId: 'chan1', msgId: 111, contentHash: 'old-hash' }
      : fallback
  ));
  const stored = [];
  t.mock.method(stateStore, 'set', async (key, value) => { stored.push({ key, value }); });
  t.mock.method(googleSheets, 'getHalls', async () => [{ id: 1, name: 'Hall A', shortName: 'A' }]);
  t.mock.method(orderStore, 'loadBlockedHalls', async () => ({ isBlocked: () => false }));
  t.mock.method(googleSheets, 'getPreorderAdminTag', async () => null);

  const sent = [];
  const deleted = [];
  const bot = {
    async sendMessage(chatId, text, opts) { sent.push({ chatId, text, opts }); return { message_id: 222 }; },
    async deleteMessage(chatId, msgId) { deleted.push({ chatId, msgId }); },
  };

  await admin.repostPreorderAvailability(bot);

  assert.equal(sent.length, 1);
  assert.equal(sent[0].chatId, 'chan1');
  assert.deepEqual(deleted, [{ chatId: 'chan1', msgId: 111 }]);

  const recorded = stored.find(s => s.key === stateStore.KEYS.preorderPost());
  assert.equal(recorded.value.msgId, 222);
  assert.equal(recorded.value.contentHash, null); // forces the next silent refresh to re-check, not skip
});

test('repostPreorderAvailability does not delete the old post if sending the new one fails', async t => {
  t.mock.method(stateStore, 'get', async (key, fallback = null) => (
    key === stateStore.KEYS.preorderPost()
      ? { channelId: 'chan1', msgId: 111, contentHash: 'old-hash' }
      : fallback
  ));
  t.mock.method(googleSheets, 'getHalls', async () => [{ id: 1, name: 'Hall A', shortName: 'A' }]);
  t.mock.method(orderStore, 'loadBlockedHalls', async () => ({ isBlocked: () => false }));
  t.mock.method(googleSheets, 'getPreorderAdminTag', async () => null);

  const deleted = [];
  const bot = {
    async sendMessage() { throw new Error('channel unreachable'); },
    async deleteMessage(chatId, msgId) { deleted.push({ chatId, msgId }); },
  };

  await assert.doesNotReject(admin.repostPreorderAvailability(bot));
  assert.equal(deleted.length, 0);
});

test('repostPreorderAvailability does nothing when every hall is blocked (nothing to announce availability for)', async t => {
  t.mock.method(stateStore, 'get', async (key, fallback = null) => (
    key === stateStore.KEYS.preorderPost()
      ? { channelId: 'chan1', msgId: 111, contentHash: 'old-hash' }
      : fallback
  ));
  t.mock.method(googleSheets, 'getHalls', async () => [{ id: 1, name: 'Hall A' }]);
  t.mock.method(orderStore, 'loadBlockedHalls', async () => ({ isBlocked: () => true }));

  const bot = { async sendMessage() { throw new Error('should not send'); } };
  await assert.doesNotReject(admin.repostPreorderAvailability(bot));
});
