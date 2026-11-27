const test = require('node:test');
const assert = require('node:assert/strict');
const { DateTime } = require('luxon');

const botPause = require('../src/services/botPause');
const orderWindow = require('../src/services/orderWindow');
const stateStore = require('../src/services/stateStore');
const orderStore = require('../src/services/orderStore');
const cartStore = require('../src/services/cartStore');
const googleSheets = require('../src/services/googleSheets');
const admin = require('../src/handlers/admin');
const { mainMenuKeyboard } = require('../src/utils/keyboards');
const { CALLBACKS } = require('../src/config/constants');

/**
 * Stop Bot / Resume Bot - see services/botPause.js and the "Stop Bot /
 * Resume Bot" section of handlers/admin.js.
 */

const SGT = 'Asia/Singapore';
const at = iso => DateTime.fromISO(iso, { zone: SGT });

const PAUSE = stateStore.KEYS.botPause();
const WINDOW = stateStore.KEYS.orderWindow();
const POST = stateStore.KEYS.preorderPost();

/** In-memory stand-in for the durable store. */
function mockStore(t, initial = {}) {
  const data = { ...initial };
  t.mock.method(stateStore, 'get', async (key, fallback = null) => (key in data ? data[key] : fallback));
  t.mock.method(stateStore, 'set', async (key, value) => { data[key] = value; });
  t.mock.method(stateStore, 'remove', async key => { delete data[key]; });
  t.mock.method(stateStore, 'update', async (key, fn) => { data[key] = fn(key in data ? data[key] : null); return data[key]; });
  t.mock.method(stateStore, 'getMany', async () => ({}));
  t.mock.method(stateStore, 'acquireLock', async () => 'holder');
  t.mock.method(stateStore, 'releaseLock', async () => true);
  return data;
}

const activePause = (extra = {}) => ({
  pausedAt: '2026-11-26T12:00:00.000Z',
  until: '2026-11-27T07:00:00.000Z',
  pausedBy: '@boss',
  pausedById: 1,
  contact: '@dingo_admin',
  previousWindow: null,
  ...extra,
});


// --- When a pause lifts ----------------------------------------------------------

test('a pause lasts until the end of the service day (3pm by default)', () => {
  // Evening: through the night, lifting the next afternoon.
  assert.equal(botPause.pauseEndsAt(at('2026-11-26T21:00')).toISO(), at('2026-11-27T15:00').toISO());
  // Small hours belong to the service day that started yesterday afternoon.
  assert.equal(botPause.pauseEndsAt(at('2026-11-27T01:30')).toISO(), at('2026-11-27T15:00').toISO());
});

test('the customer message names the contact and fits in a callback alert', () => {
  const text = botPause.customerPausedText(activePause());
  assert.match(text, /@dingo_admin/);
  assert.ok(text.length <= 200);
  assert.match(botPause.customerPausedText(activePause({ contact: null })), /an admin/);
});


// --- Ordering is refused --------------------------------------------------------

test('isOrderingOpen is false while paused, even in stage 2', async t => {
  const data = mockStore(t, { [WINDOW]: { stage: orderWindow.STAGES.STAGE2 } });
  assert.equal(await orderWindow.isOrderingOpen(), true);

  data[PAUSE] = activePause();
  assert.equal(await orderWindow.isOrderingOpen(), false);
});


// --- Main menu ------------------------------------------------------------------

test('the main menu swaps Stop Bot for Resume Bot, and hides Extend, while paused', () => {
  const callbacks = options => mainMenuKeyboard(options).inline_keyboard.flat().map(button => button.callback_data);

  const running = callbacks({ showExtend: true });
  assert.ok(running.includes(CALLBACKS.ADMIN_PAUSE));
  assert.ok(!running.includes(CALLBACKS.ADMIN_RESUME));
  assert.ok(running.includes(CALLBACKS.STAGE1_EXTEND));

  const paused = callbacks({ showExtend: true, paused: true });
  assert.ok(paused.includes(CALLBACKS.ADMIN_RESUME));
  assert.ok(!paused.includes(CALLBACKS.ADMIN_PAUSE));
  assert.ok(!paused.includes(CALLBACKS.STAGE1_EXTEND));
});

test('posting orders open is refused while paused', async t => {
  mockStore(t, { [PAUSE]: activePause() });
  const answers = [];
  const bot = { async sendMessage() { throw new Error('should not post or prompt'); } };

  const handled = await admin.handleStageCallbacks(
    bot, { from: { id: 1 }, message: { message_id: 5 } }, 1, 1, CALLBACKS.STAGE1_POST,
    async (text, options) => { answers.push({ text, options }); }
  );

  assert.equal(handled, true);
  assert.match(answers[0].text, /stopped/);
});

test('no "orders open" reminders go out while paused', async t => {
  mockStore(t, { [PAUSE]: activePause() });
  const bot = { async sendMessage() { throw new Error('should not remind'); } };

  // 17:45 is inside the reminder window for the default 18:00 post time.
  assert.equal(await admin.runOrderReminders(bot, at('2026-11-26T17:45')), null);
});


// --- Channel post ---------------------------------------------------------------

test('the preorder post is edited to "message the admin" with its button removed', async t => {
  mockStore(t, {
    [PAUSE]: activePause(),
    [POST]: { channelId: 'chan', msgId: 10, contentHash: 'old' },
  });
  // A paused post names no hall, so Sheets is never needed.
  t.mock.method(googleSheets, 'getHallsOrThrow', async () => { throw new Error('should not read halls'); });

  const edits = [];
  const bot = { async editMessageText(text, opts) { edits.push({ text, opts }); } };

  await admin.refreshPreorderPost(bot);

  assert.equal(edits.length, 1);
  assert.match(edits[0].text, /paused for today/);
  assert.match(edits[0].text, /@dingo_admin/);
  assert.deepEqual(edits[0].opts.reply_markup, { inline_keyboard: [] });
});


// --- Admin order list -----------------------------------------------------------

const order = (code, hallName, status, items, extra = {}) => ({
  code, hallName, status, items, userId: 7, username: 'cust', phoneNumber: '91234567', chatId: 7, ...extra,
});

test('the admin order list follows hall (route) order, with item totals per hall', () => {
  const halls = [{ name: 'Hall 1' }, { name: 'Hall 2' }, { name: 'Hall 3' }];
  const orders = [
    order('B1', 'Hall 2', 'paid', [{ name: 'Milo', quantity: 1 }]),
    order('A1', 'Hall 1', 'awaiting_payment', [{ name: 'Chicken Rice', quantity: 2 }]),
    order('A2', 'Hall 1', 'paid', [{ name: 'Chicken Rice', quantity: 1 }, { name: 'Milo', quantity: 1 }]),
    order('Z1', 'Old Hall', 'paid', [{ name: 'Milo', quantity: 1 }]),
  ];

  const report = admin.buildPauseOrdersReport(halls, orders);

  assert.match(report, /Orders still to deliver \(4\)/);
  const hall1 = report.indexOf('Hall 1');
  const hall2 = report.indexOf('Hall 2');
  const oldHall = report.indexOf('Old Hall');
  assert.ok(hall1 < hall2 && hall2 < oldHall, 'route order, unknown halls last');
  assert.doesNotMatch(report, /Hall 3/); // no orders there, not listed
  assert.match(report, /Items: Chicken Rice x3, Milo x1/);
  assert.match(report, /91234567 @cust — Chicken Rice x2 — 💳 Unpaid \(A1\)/);
});

test('the admin order list says so when nothing is left', () => {
  assert.match(admin.buildPauseOrdersReport([{ name: 'Hall 1' }], []), /No orders left/);
});

test('a long report is split into messages under Telegram\'s limit', () => {
  const text = Array.from({ length: 300 }, (_, i) => `line ${i} ${'x'.repeat(40)}`).join('\n');
  const chunks = admin.splitForTelegram(text);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every(chunk => chunk.length <= 3900));
  assert.equal(chunks.join('\n'), text);
});


// --- Stop / resume end to end ---------------------------------------------------

function mockPauseDependencies(t, { carts = [], orders = [] } = {}) {
  const cleared = [];
  t.mock.method(cartStore, 'getOpenCartUserIds', async () => carts);
  t.mock.method(cartStore, 'clearCart', async id => { cleared.push(id); });
  t.mock.method(orderStore, 'getActiveOrders', async () => orders);
  t.mock.method(googleSheets, 'getHalls', async () => [{ name: 'Hall 1' }]);
  t.mock.method(googleSheets, 'getAdminIds', () => [900]);
  t.mock.method(googleSheets, 'getPreorderAdminTag', async () => 555);
  t.mock.method(googleSheets, 'getAdminUsernameById', async () => 'dingo_admin');
  return { cleared };
}

test('Stop Bot closes the round, clears carts, tells customers and sends admins the list', async t => {
  const stage2 = { stage: orderWindow.STAGES.STAGE2, postedAt: '2026-11-26T10:00:00.000Z', cutoffAt: null };
  const data = mockStore(t, { [WINDOW]: stage2 });
  const { cleared } = mockPauseDependencies(t, {
    carts: [41, 42],
    orders: [
      order('A1', 'Hall 1', 'awaiting_payment', [{ name: 'Milo', quantity: 1 }], { chatId: 50 }),
      order('A2', 'Hall 1', 'paid', [{ name: 'Milo', quantity: 1 }], { chatId: 51 }),
    ],
  });

  const sent = [];
  const bot = { async sendMessage(chatId, text) { sent.push({ chatId, text }); return { message_id: 1 }; } };

  const result = await admin.pauseBot(bot, { id: 1, username: 'boss' });

  assert.equal(result.paused, true);
  assert.equal(data[PAUSE].contact, '@dingo_admin');
  assert.deepEqual(data[PAUSE].previousWindow, stage2);
  assert.equal(data[WINDOW].stage, orderWindow.STAGES.CLOSED); // can't reopen on its own tomorrow

  assert.deepEqual(cleared, [41, 42]);
  const toCustomer = id => sent.filter(m => m.chatId === id);
  assert.match(toCustomer(41)[0].text, /cart has been cleared[\s\S]*@dingo_admin/);
  assert.match(toCustomer(50)[0].text, /A1 is still saved/);
  assert.equal(toCustomer(51).length, 0); // already paid - nothing to tell them

  const toAdmin = sent.filter(m => m.chatId === 900).map(m => m.text).join('\n');
  assert.match(toAdmin, /STOPPED by @boss/);
  assert.match(toAdmin, /Orders still to deliver \(2\)/);
});

test('Stop Bot does nothing a second time', async t => {
  mockStore(t, { [PAUSE]: activePause() });
  const bot = { async sendMessage() { throw new Error('should not send'); } };
  assert.deepEqual(await admin.pauseBot(bot, { id: 1 }), { paused: false, reason: 'already_paused' });
});

test('Resume Bot puts the night back how it was before the stop', async t => {
  const stage2 = { stage: orderWindow.STAGES.STAGE2, postedAt: '2026-11-26T10:00:00.000Z', cutoffAt: null };
  const data = mockStore(t, {
    [PAUSE]: activePause({ previousWindow: stage2 }),
    [WINDOW]: { ...stage2, stage: orderWindow.STAGES.CLOSED },
  });
  mockPauseDependencies(t);

  const sent = [];
  const bot = { async sendMessage(chatId, text) { sent.push({ chatId, text }); return { message_id: 1 }; } };

  const result = await admin.resumeBot(bot, { id: 1, username: 'boss' });

  assert.equal(result.resumed, true);
  assert.equal(result.open, true);
  assert.equal(data[PAUSE], undefined);
  assert.deepEqual(data[WINDOW], stage2);
  assert.match(sent.find(m => m.chatId === 900).text, /resumed by @boss[\s\S]*open again/);
});

// --- Stop until I resume ----------------------------------------------------------

test('an indefinite pause has no end time and no expiry', async t => {
  const writes = [];
  t.mock.method(stateStore, 'set', async (key, value, options) => { writes.push({ key, value, options }); });

  const pause = await botPause.startPause({ pausedBy: '@boss', indefinite: true }, at('2026-11-27T21:00'));

  assert.equal(pause.until, null);
  assert.equal(writes[0].options.ttlMs, null);
  assert.equal(botPause.isIndefinite(pause), true);
  assert.equal(botPause.formatSince(pause), '27 Nov');
  assert.equal(botPause.isIndefinite(activePause()), false);
});

test('an indefinite pause says "for now", not "for today"', () => {
  const pause = activePause({ until: null });
  assert.match(botPause.customerPausedText(pause), /paused for now/);
  assert.match(botPause.channelPausedText(pause), /paused for now/);
  assert.doesNotMatch(botPause.channelPausedText(pause), /today/);
});

test('the Stop keyboard has for today, until I resume, and cancel', () => {
  const { stopBotKeyboard } = require('../src/utils/keyboards');
  const callbacks = stopBotKeyboard().inline_keyboard.flat().map(b => b.callback_data);
  assert.deepEqual(callbacks, [CALLBACKS.ADMIN_PAUSE_CONFIRM, CALLBACKS.ADMIN_PAUSE_INDEFINITE_CONFIRM, CALLBACKS.ADMIN_MENU_BACK]);
});

test('Stop until I resume: no expiry, admins told it waits for Resume, customers not told "something went wrong"', async t => {
  const stage2 = { stage: orderWindow.STAGES.STAGE2, postedAt: '2026-11-26T10:00:00.000Z', cutoffAt: null };
  const data = mockStore(t, { [WINDOW]: stage2 });
  mockPauseDependencies(t, { carts: [41] });

  const sent = [];
  const bot = { async sendMessage(chatId, text) { sent.push({ chatId, text }); return { message_id: 1 }; } };

  const result = await admin.pauseBot(bot, { id: 1, username: 'boss' }, { indefinite: true });

  assert.equal(result.paused, true);
  assert.equal(data[PAUSE].until, null);
  assert.equal(data[WINDOW].stage, orderWindow.STAGES.CLOSED);

  const toCustomer = sent.find(m => m.chatId === 41).text;
  assert.match(toCustomer, /paused for now/);
  assert.doesNotMatch(toCustomer, /gone wrong/);

  const toAdmin = sent.filter(m => m.chatId === 900).map(m => m.text).join('\n');
  assert.match(toAdmin, /STOPPED by @boss until someone taps Resume Bot/);
});

test('Resume after "until I resume" keeps ordering closed instead of reopening the old round', async t => {
  const stage2 = { stage: orderWindow.STAGES.STAGE2, postedAt: '2026-11-26T10:00:00.000Z', cutoffAt: null };
  const closed = { ...stage2, stage: orderWindow.STAGES.CLOSED };
  const data = mockStore(t, {
    [PAUSE]: activePause({ until: null, previousWindow: stage2 }),
    [WINDOW]: closed,
  });
  mockPauseDependencies(t);

  const sent = [];
  const bot = { async sendMessage(chatId, text) { sent.push({ chatId, text }); return { message_id: 1 }; } };

  const result = await admin.resumeBot(bot, { id: 1, username: 'boss' });

  assert.equal(result.resumed, true);
  assert.equal(result.open, false);
  assert.equal(data[PAUSE], undefined);
  assert.deepEqual(data[WINDOW], closed);
  assert.match(sent.find(m => m.chatId === 900).text, /stays closed/);
});

test('reminders stay off during an indefinite pause', async t => {
  mockStore(t, { [PAUSE]: activePause({ until: null }) });
  const bot = { async sendMessage() { throw new Error('should not remind'); } };
  assert.equal(await admin.runOrderReminders(bot, at('2026-12-03T17:45')), null);
});

test('Resume Bot leaves the window alone if an admin changed it during the stop', async t => {
  const stage2 = { stage: orderWindow.STAGES.STAGE2, postedAt: '2026-11-26T10:00:00.000Z', cutoffAt: null };
  const newerRound = { stage: orderWindow.STAGES.CLOSED, postedAt: '2026-11-26T13:00:00.000Z', cutoffAt: null };
  const data = mockStore(t, { [PAUSE]: activePause({ previousWindow: stage2 }), [WINDOW]: newerRound });
  mockPauseDependencies(t);

  const bot = { async sendMessage() { return { message_id: 1 }; } };
  await admin.resumeBot(bot, { id: 1 });

  assert.deepEqual(data[WINDOW], newerRound);
});
