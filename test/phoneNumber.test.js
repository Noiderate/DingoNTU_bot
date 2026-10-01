const test = require('node:test');
const assert = require('node:assert/strict');

const user = require('../src/handlers/user');
const repo = require('../src/services/orderRepository');
const stateStore = require('../src/services/stateStore');
const cartStore = require('../src/services/cartStore');
const orderStore = require('../src/services/orderStore');
const googleSheets = require('../src/services/googleSheets');

/** Ordering open, one hall, nothing else in state unless `extra` says so. */
function startFlowMocks(t, extra = {}) {
  t.mock.method(cartStore, 'clearCart', async () => {});
  t.mock.method(stateStore, 'get', async (key, fallback = null) => {
    if (key === stateStore.KEYS.preorderPost()) return { channelId: 'chan1', msgId: 111 };
    return key in extra ? extra[key] : fallback;
  });
  t.mock.method(stateStore, 'set', async () => {});
  t.mock.method(stateStore, 'remove', async () => {});
  t.mock.method(orderStore, 'loadBlockedHalls', async () => ({ isBlocked: () => false }));
  t.mock.method(googleSheets, 'getHallsOrThrow', async () => [{ id: 2, name: 'Hall A' }]);
}

/**
 * A customer must have a phone number on file before their order can be
 * confirmed, so staff at the hall can reach them - a Telegram handle alone
 * isn't enough. Collected once, on whichever order first hits the gate.
 */

test('normalizePhoneNumber strips formatting and accepts a plausible length', () => {
  assert.equal(user.normalizePhoneNumber('91234567'), '91234567');
  assert.equal(user.normalizePhoneNumber('9123-4567'), '91234567');
});

test('normalizePhoneNumber drops a Singapore 65 country code but keeps other country codes', () => {
  assert.equal(user.normalizePhoneNumber('+65 9123 4567'), '91234567');
  assert.equal(user.normalizePhoneNumber('(65) 9123 4567'), '91234567');
  assert.equal(user.normalizePhoneNumber('6591234567'), '91234567'); // a shared contact
  assert.equal(user.normalizePhoneNumber('+60 12-345 6789'), '60123456789');
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

  assert.equal(stored[stateStore.KEYS.awaitingPhoneNumber(999)].value, 'confirm');
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

test('handlePhoneNumberReply reports an error and leaves the prompt state in place if saving fails, instead of looping silently', async t => {
  // Regression test: this exact gap (an uncaught throw here) is what turns a
  // save failure - most likely customers.phone_number missing from the
  // database because migration 0006 wasn't applied - into an infinite
  // silent loop: the state below never clears, so every later message
  // re-triggers the same "we need a contact number" prompt with the
  // customer never told anything went wrong.
  t.mock.method(repo, 'upsertCustomer', async () => { throw new Error('column "phone_number" does not exist'); });

  let removeCalled = false;
  t.mock.method(stateStore, 'remove', async () => { removeCalled = true; });

  const sent = [];
  const bot = { async sendMessage(chatId, text) { sent.push({ chatId, text }); } };

  const msg = { chat: { id: 555 }, from: { id: 999, username: 'ali', first_name: 'Ali' }, text: '91234567' };
  await assert.doesNotReject(user.handlePhoneNumberReply(bot, msg));

  assert.equal(removeCalled, false); // state must stay so the customer isn't stuck with no way back in
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /something went wrong/i);
  assert.doesNotMatch(sent[0].text, /Confirm Order/); // must not claim success
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

test('requestPhoneNumber offers a one-tap share-contact button', async t => {
  t.mock.method(stateStore, 'set', async () => {});

  const sent = [];
  const bot = { async sendMessage(chatId, text, opts) { sent.push(opts); } };

  await user.requestPhoneNumber(bot, 555, 999);

  assert.equal(sent[0].reply_markup.keyboard[0][0].request_contact, true);
});

test('a shared contact is saved without the 65 prefix and the button is removed', async t => {
  let saved = null;
  t.mock.method(repo, 'upsertCustomer', async input => { saved = input; return { id: 'c1' }; });
  t.mock.method(stateStore, 'get', async key => key === stateStore.KEYS.awaitingPhoneNumber(999));
  t.mock.method(stateStore, 'remove', async () => {});

  const sent = [];
  const bot = { async sendMessage(chatId, text, opts) { sent.push({ text, opts }); } };

  const msg = {
    chat: { id: 555 },
    from: { id: 999, first_name: 'Ali' },
    contact: { phone_number: '+6591234567', user_id: 999, first_name: 'Ali' },
  };
  assert.equal(await user.handleUserCommand(bot, msg), true);

  assert.equal(saved.phoneNumber, '91234567');
  assert.equal(sent[0].opts.reply_markup.remove_keyboard, true);
});

test('a contact belonging to someone else sent from the attachment menu is refused', async t => {
  t.mock.method(repo, 'upsertCustomer', async () => { throw new Error('should not be called'); });
  t.mock.method(stateStore, 'get', async () => true);

  const sent = [];
  const bot = { async sendMessage(chatId, text) { sent.push(text); } };

  const msg = {
    chat: { id: 555 },
    from: { id: 999 },
    contact: { phone_number: '6598765432', user_id: 12345 },
  };
  await user.handleUserCommand(bot, msg);

  assert.match(sent[0], /your own number/);
});

test('a first /start with no number on file asks for one instead of showing the halls', async t => {
  startFlowMocks(t);
  t.mock.method(repo, 'getCustomerByTelegramId', async () => null);

  const sent = [];
  const bot = { async sendMessage(chatId, text, opts) { sent.push({ text, opts }); } };

  await user.handleUserCommand(bot, { chat: { id: 555 }, from: { id: 999 }, text: '/start' });

  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /contact number/);
  assert.doesNotMatch(sent[0].text, /Confirm Order/);
  assert.equal(sent[0].opts.reply_markup.keyboard[0][0].request_contact, true);
});

test('/start goes straight to the halls when a number is already on file', async t => {
  startFlowMocks(t);
  t.mock.method(repo, 'getCustomerByTelegramId', async () => ({ id: 'c1', phone_number: '91234567' }));

  const sent = [];
  const bot = { async sendMessage(chatId, text) { sent.push(text); return { message_id: 1 }; } };

  await user.handleUserCommand(bot, { chat: { id: 555 }, from: { id: 999 }, text: '/start' });

  assert.equal(sent.length, 1);
  assert.match(sent[0], /select your hall/);
});

test('saving the number asked for at /start carries on to the hall menu', async t => {
  startFlowMocks(t, { [stateStore.KEYS.awaitingPhoneNumber(999)]: 'start' });
  t.mock.method(repo, 'upsertCustomer', async () => ({ id: 'c1' }));

  const sent = [];
  const bot = { async sendMessage(chatId, text, opts) { sent.push({ text, opts }); return { message_id: 1 }; } };

  const msg = {
    chat: { id: 555 },
    from: { id: 999 },
    contact: { phone_number: '6591234567', user_id: 999 },
  };
  await user.handleUserCommand(bot, msg);

  assert.equal(sent.length, 2);
  assert.equal(sent[0].opts.reply_markup.remove_keyboard, true);
  assert.doesNotMatch(sent[0].text, /Confirm Order/);
  assert.match(sent[1].text, /select your hall/);
});
