const test = require('node:test');
const assert = require('node:assert/strict');

const user = require('../src/handlers/user');
const repo = require('../src/services/orderRepository');
const stateStore = require('../src/services/stateStore');
const cartStore = require('../src/services/cartStore');

/**
 * A customer must have a phone number on file before their order can be
 * confirmed, so staff at the hall can reach them - a Telegram handle alone
 * isn't enough. Collected once, on whichever order first hits the gate.
 */

test('normalizePhoneNumber strips formatting and accepts a plausible length', () => {
  assert.equal(user.normalizePhoneNumber('91234567'), '91234567');
  assert.equal(user.normalizePhoneNumber('+65 9123 4567'), '6591234567');
  assert.equal(user.normalizePhoneNumber('9123-4567'), '91234567');
  assert.equal(user.normalizePhoneNumber('(65) 9123 4567'), '6591234567');
});

test('normalizePhoneNumber rejects text with no plausible number in it', () => {
  assert.equal(user.normalizePhoneNumber('idk'), null);
  assert.equal(user.normalizePhoneNumber(''), null);
  assert.equal(user.normalizePhoneNumber(undefined), null);
});

test('normalizePhoneNumber rejects implausibly short or long digit runs', () => {
  assert.equal(user.normalizePhoneNumber('12345'), null); // 5 digits
  assert.equal(user.normalizePhoneNumber('1234567'), '1234567'); // 7 digits, the floor
  assert.equal(user.normalizePhoneNumber('123456789012345'), '123456789012345'); // 15, the ceiling
  assert.equal(user.normalizePhoneNumber('1234567890123456'), null); // 16 digits
});

test('requestPhoneNumber sets the awaiting-reply state and asks for a number', async t => {
  const stored = {};
  t.mock.method(stateStore, 'set', async (key, value, opts) => { stored[key] = { value, opts }; });

  const sent = [];
  const bot = { async sendMessage(chatId, text) { sent.push({ chatId, text }); } };

  await user.requestPhoneNumber(bot, 555, 999);

  assert.deepEqual(stored[stateStore.KEYS.awaitingPhoneNumber(999)].value, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].chatId, 555);
  assert.match(sent[0].text, /phone number/i);
});

test('handlePhoneNumberReply saves a valid number, clears the state, and confirms', async t => {
  let saved = null;
  t.mock.method(repo, 'upsertCustomer', async input => { saved = input; return { id: 'c1' }; });

  let removedKey = null;
  t.mock.method(stateStore, 'remove', async key => { removedKey = key; });

  const sent = [];
  const bot = { async sendMessage(chatId, text) { sent.push({ chatId, text }); } };

  const msg = { chat: { id: 555 }, from: { id: 999, username: 'ali', first_name: 'Ali' }, text: '91234567' };
  await user.handlePhoneNumberReply(bot, msg);

  assert.equal(saved.telegramUserId, 999);
  assert.equal(saved.phoneNumber, '91234567');
  assert.equal(saved.username, 'ali');
  assert.equal(removedKey, stateStore.KEYS.awaitingPhoneNumber(999));
  assert.match(sent[0].text, /Confirm Order/);
});

test('handleConfirmOrder asks for a phone number instead of touching stock/locks when none is on file', async t => {
  t.mock.method(repo, 'getCustomerByTelegramId', async () => null);
  t.mock.method(stateStore, 'withLock', async () => { throw new Error('should not reach the lock'); });
  t.mock.method(stateStore, 'set', async () => {});

  const sent = [];
  const bot = {
    async sendMessage(chatId, text) { sent.push({ chatId, text }); },
    async answerCallbackQuery() {},
  };
  const query = { id: 'q1', from: {}, message: { message_id: 1, chat: { id: 555 } } };

  await user.handleConfirmOrder(bot, query, 555, 999);

  assert.match(sent[0].text, /phone number/i);
});

test('handleConfirmOrder proceeds past the gate once a phone number is on file', async t => {
  t.mock.method(repo, 'getCustomerByTelegramId', async () => ({ id: 'c1', phone_number: '91234567' }));

  let reachedLock = false;
  t.mock.method(stateStore, 'withLock', async (name, task) => {
    reachedLock = true;
    return task();
  });
  // Lets the confirm logic bail out immediately once inside the lock (no
  // hall selected), so this only has to prove the gate let it through.
  t.mock.method(cartStore, 'getCart', async () => ({ hallName: null, items: {} }));

  const bot = { async sendMessage() {}, async answerCallbackQuery() {} };
  const query = { id: 'q1', from: {}, message: { message_id: 1, chat: { id: 555 } } };

  await user.handleConfirmOrder(bot, query, 555, 999);

  assert.equal(reachedLock, true);
});

test('handlePhoneNumberReply rejects garbage without touching the customer record or the state', async t => {
  t.mock.method(repo, 'upsertCustomer', async () => { throw new Error('should not be called'); });
  t.mock.method(stateStore, 'remove', async () => { throw new Error('should not be called'); });

  const sent = [];
  const bot = { async sendMessage(chatId, text) { sent.push({ chatId, text }); } };

  const msg = { chat: { id: 555 }, from: { id: 999 }, text: 'not a number' };
  await user.handlePhoneNumberReply(bot, msg);

  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /valid phone number/i);
});
