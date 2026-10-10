const test = require('node:test');
const assert = require('node:assert/strict');
const { DateTime } = require('luxon');

const orderWindow = require('../src/services/orderWindow');
const stateStore = require('../src/services/stateStore');
const menuStore = require('../src/services/menuStore');
const orderStore = require('../src/services/orderStore');
const googleSheets = require('../src/services/googleSheets');
const admin = require('../src/handlers/admin');
const { STATES, CALLBACKS } = require('../src/config/constants');

const SGT = 'Asia/Singapore';
const at = (iso) => DateTime.fromISO(iso, { zone: SGT });

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

const WINDOW = stateStore.KEYS.orderWindow();
const POST = stateStore.KEYS.preorderPost();
const SCHEDULE = stateStore.KEYS.orderSchedule();


// --- Clock parsing / formatting -------------------------------------------------

test('parseClock reads 12-hour and 24-hour times, rejects nonsense', () => {
  assert.equal(orderWindow.parseClock('6pm'), '18:00');
  assert.equal(orderWindow.parseClock('6:30 PM'), '18:30');
  assert.equal(orderWindow.parseClock('12:30am'), '00:30');
  assert.equal(orderWindow.parseClock('12pm'), '12:00');
  assert.equal(orderWindow.parseClock('18:00'), '18:00');
  assert.equal(orderWindow.parseClock('0030'), '00:30');
  assert.equal(orderWindow.parseClock('25:00'), null);
  assert.equal(orderWindow.parseClock('13pm'), null);
  assert.equal(orderWindow.parseClock('6:75'), null);
  assert.equal(orderWindow.parseClock('soon'), null);
});

test('formatClock shows a friendly 12-hour time', () => {
  assert.equal(orderWindow.formatClock('00:30'), '12:30 AM');
  assert.equal(orderWindow.formatClock('18:00'), '6:00 PM');
  assert.equal(orderWindow.formatClock('12:05'), '12:05 PM');
});

test('the cutoff is the next time the clock reads it, even across midnight', () => {
  assert.equal(orderWindow.nextOccurrence(at('2026-10-08T18:05'), '00:30').toISO(), at('2026-10-09T00:30').toISO());
  assert.equal(orderWindow.nextOccurrence(at('2026-10-09T00:10'), '00:30').toISO(), at('2026-10-09T00:30').toISO());
});


// --- Is ordering open? ----------------------------------------------------------

test('ordering is open in stage 1 only until the cutoff, then closed until stage 2', async t => {
  const data = mockStore(t);
  data[WINDOW] = { stage: 'stage1', postedAt: at('2026-10-08T18:00').toUTC().toISO(), cutoffAt: at('2026-10-09T00:30').toUTC().toISO() };

  assert.equal(await orderWindow.isOrderingOpen(at('2026-10-08T23:59')), true);
  assert.equal(await orderWindow.isOrderingOpen(at('2026-10-09T00:30')), false); // sharp, no tick needed

  data[WINDOW] = { ...data[WINDOW], stage: 'closed' };
  assert.equal(await orderWindow.isOrderingOpen(at('2026-10-08T20:00')), false);

  data[WINDOW] = { ...data[WINDOW], stage: 'stage2' };
  assert.equal(await orderWindow.isOrderingOpen(at('2026-10-09T01:30')), true);
});

test('with no stage recorded, ordering follows whether a preorder post exists', async t => {
  const data = mockStore(t);
  assert.equal(await orderWindow.isOrderingOpen(), false);

  data[POST] = { channelId: 'c', msgId: 5 };
  assert.equal(await orderWindow.isOrderingOpen(), true);
});

test('changing the cutoff while stage 1 is live moves this round\'s cutoff', async t => {
  const data = mockStore(t);
  data[WINDOW] = { stage: 'stage1', postedAt: at('2026-10-08T18:00').toUTC().toISO(), cutoffAt: at('2026-10-09T00:30').toUTC().toISO() };

  assert.equal(await orderWindow.recomputeCutoff('23:00'), true);
  assert.equal(data[WINDOW].cutoffAt, at('2026-10-08T23:00').toUTC().toISO());

  data[WINDOW] = { stage: 'closed' };
  assert.equal(await orderWindow.recomputeCutoff('23:00'), false);
});


// --- Reminders ------------------------------------------------------------------

test('reminder at T-30, one nudge at the target time, never once stage 1 is out', () => {
  const base = { postTime: '18:00', window: null, reminders: null };

  assert.equal(orderWindow.reminderAction({ ...base, now: at('2026-10-08T17:29') }), null);
  assert.equal(orderWindow.reminderAction({ ...base, now: at('2026-10-08T17:30') }), 'remind');
  assert.equal(orderWindow.reminderAction({ ...base, now: at('2026-10-08T17:45'), reminders: { date: '2026-10-08', reminded: true } }), null);
  assert.equal(orderWindow.reminderAction({ ...base, now: at('2026-10-08T18:00'), reminders: { date: '2026-10-08', reminded: true } }), 'nudge');
  assert.equal(orderWindow.reminderAction({ ...base, now: at('2026-10-08T18:10'), reminders: { date: '2026-10-08', reminded: true, nudged: true } }), null);

  // Already posted tonight: nothing.
  const posted = { stage: 'stage1', postedAt: at('2026-10-08T17:50').toUTC().toISO() };
  assert.equal(orderWindow.reminderAction({ ...base, now: at('2026-10-08T18:00'), window: posted }), null);

  // Yesterday's window doesn't suppress tonight's reminder; stale ones are skipped.
  const yesterday = { stage: 'stage2', postedAt: at('2026-10-07T18:00').toUTC().toISO() };
  assert.equal(orderWindow.reminderAction({ ...base, now: at('2026-10-08T17:30'), window: yesterday }), 'remind');
  assert.equal(orderWindow.reminderAction({ ...base, now: at('2026-10-08T23:00') }), null);
});

test('runOrderReminders DMs every admin once, with a Post button', async t => {
  mockStore(t);
  t.mock.method(googleSheets, 'getAdminIds', () => [11, 22]);

  const sent = [];
  const bot = { async sendMessage(chatId, text, opts) { sent.push({ chatId, text, opts }); return { message_id: 1000 + chatId }; } };

  assert.equal(await admin.runOrderReminders(bot, at('2026-10-08T17:30')), 'remind');
  assert.deepEqual(sent.map(entry => entry.chatId), [11, 22]);
  assert.match(sent[0].text, /6:00 PM/);
  assert.equal(sent[0].opts.reply_markup.inline_keyboard[0][0].callback_data, CALLBACKS.STAGE1_POST);

  sent.length = 0;
  assert.equal(await admin.runOrderReminders(bot, at('2026-10-08T17:40')), null);
  assert.equal(sent.length, 0);
});


// --- Stock figures --------------------------------------------------------------

test('stockFigures: total is the opening stock (plus any adjustment), sold is what stage 1 took', () => {
  const item = { id: 3, stock: 4, baselineStock: 20 };

  assert.deepEqual(orderWindow.stockFigures(item), { total: 20, sold: 16, remaining: 4, hasBaseline: true });
  assert.deepEqual(orderWindow.stockFigures(item, { 3: -5 }), { total: 15, sold: 11, remaining: 4, hasBaseline: true });
  assert.deepEqual(orderWindow.stockFigures({ id: 4, stock: 7, baselineStock: null }), { total: 7, sold: 0, remaining: 7, hasBaseline: false });
});


// --- Cutoff edits the post ------------------------------------------------------

test('at the cutoff the stage-1 post is edited to "ordering closed" and loses its button', async t => {
  const data = mockStore(t);
  data[WINDOW] = { stage: 'stage1', postedAt: at('2026-10-08T18:00').toUTC().toISO(), cutoffAt: at('2026-10-09T00:30').toUTC().toISO() };
  data[POST] = { channelId: 'chan', msgId: 9, photoFileId: null, contentHash: 'old' };
  t.mock.method(googleSheets, 'getHallsOrThrow', async () => [{ id: 2, name: 'Hall A' }]);
  t.mock.method(orderStore, 'loadBlockedHalls', async () => ({ isBlocked: () => false }));
  t.mock.method(menuStore, 'getFoodItemsOrThrow', async () => []);
  t.mock.method(googleSheets, 'getPreorderAdminTag', async () => null);

  // Not due yet at this moment in real time, so force the clock via the window.
  data[WINDOW].cutoffAt = DateTime.now().minus({ minutes: 1 }).toUTC().toISO();

  const edits = [];
  const bot = {
    async editMessageText(text, opts) { edits.push({ text, opts }); },
    async getMe() { return { username: 'bot' }; },
  };

  const result = await admin.enforceOrderCutoff(bot);

  assert.equal(result.closed, true);
  assert.equal(data[WINDOW].stage, 'closed');
  assert.match(edits[0].text, /Ordering is now closed/);
  assert.deepEqual(edits[0].opts.reply_markup, { inline_keyboard: [] });

  // A second tick does nothing.
  assert.deepEqual(await admin.enforceOrderCutoff(bot), { skipped: 'not_due' });
});


// --- Stage 1 post ---------------------------------------------------------------

function mockRoundReset(t, calls) {
  t.mock.method(orderStore, 'getActiveOrders', async () => []);
  t.mock.method(orderStore, 'getRecentServedUnpaidOrders', async () => []);
  t.mock.method(menuStore, 'restoreStockBaselines', async () => { calls.push('reset'); return { changes: [], noBaselineItems: [] }; });
  t.mock.method(orderStore, 'clearBlockedHalls', async () => {});
  t.mock.method(orderStore, 'loadBlockedHalls', async () => ({ isBlocked: () => false }));
}

test('postStageOne resets last round, posts with the cutoff, then opens stage 1 and removes old posts', async t => {
  const data = mockStore(t, {
    [SCHEDULE]: { postTime: '18:00', cutoffTime: '00:30' },
    [stateStore.KEYS.dingoPosts()]: { coming: 41, here: null, 'get-ready': null },
    [POST]: { channelId: 'chan', msgId: 40 },
  });
  data[WINDOW] = { stage: 'stage2' };
  const calls = [];
  mockRoundReset(t, calls);
  t.mock.method(googleSheets, 'getHalls', async () => [{ id: 2, name: 'Hall A', shortName: 'A' }]);
  t.mock.method(googleSheets, 'getHallsOrThrow', async () => [{ id: 2, name: 'Hall A', shortName: 'A' }]);
  t.mock.method(googleSheets, 'getPreorderAdminTag', async () => null);
  t.mock.method(googleSheets, 'getAdminIds', () => [11]);
  t.mock.method(menuStore, 'getFoodItemsOrThrow', async () => [{ id: 1, name: 'Chicken Rice', stock: 5 }]);

  const sent = [];
  const deleted = [];
  const bot = {
    async sendMessage(chatId, text, opts) { sent.push({ chatId, text, opts }); return { message_id: 50 }; },
    async deleteMessage(chatId, id) { deleted.push(id); },
    async getMe() { return { username: 'bot' }; },
  };

  const result = await admin.postStageOne(bot, { notifyChatId: 11 });

  assert.equal(result.posted, true);
  assert.deepEqual(calls, ['reset']);
  const channelPost = sent.find(entry => entry.chatId === (require('../src/config').config.telegram.dingoChannelId));
  assert.ok(channelPost, 'the orders-open post went to the channel');
  assert.match(channelPost.text, /Order form cuts off at 12\.30am\nDelivery is approx\. 15mins after form cut off/);
  assert.match(channelPost.text, /Chicken Rice/);
  assert.deepEqual(deleted.sort(), [40, 41]);
  assert.equal(data[POST].msgId, 50);
  assert.equal(data[WINDOW].stage, 'stage1');
  assert.ok(sent.some(entry => entry.chatId === 11 && /were reset/.test(entry.text)), 'summary DM sent');
});


// --- Stage 2 --------------------------------------------------------------------

test('showing the confirm-stock screen with no stage-1 post resets first, then lists total/sold/remaining', async t => {
  const data = mockStore(t);
  const calls = [];
  mockRoundReset(t, calls);
  t.mock.method(googleSheets, 'getHalls', async () => [{ id: 2, name: 'Hall A' }]);
  t.mock.method(menuStore, 'getFoodItemsOrThrow', async () => [{ id: 1, name: 'Chicken Rice', stock: 3, baselineStock: 20 }]);

  const sent = [];
  const bot = {
    async sendMessage(chatId, text, opts) { sent.push({ chatId, text, opts }); return { message_id: 70 }; },
    async editMessageText(text, opts) { sent.push({ text, opts }); },
  };
  const answers = [];

  await admin.showStageTwoPanel(bot, 11, 11, 2, async (...args) => { answers.push(args); });

  assert.deepEqual(calls, ['reset']);
  assert.equal(data[WINDOW].stage, 'closed');
  const panel = sent[sent.length - 1];
  assert.match(panel.text, /Chicken Rice/);
  assert.match(panel.text, /total 20 · sold 17 · remaining 3/);
  const buttons = panel.opts.reply_markup.inline_keyboard.flat().map(button => button.callback_data);
  assert.ok(buttons.includes(CALLBACKS.STAGE2_CONFIRM));
  assert.ok(buttons.includes(`${CALLBACKS.STAGE2_EDIT_PREFIX}1`));
});

test('a stage-2 total lower than what is already sold is refused, and the admin is asked again', async t => {
  mockStore(t, { [stateStore.KEYS.stagePanel()]: { hallId: 2, adjust: {} } });
  t.mock.method(menuStore, 'getFoodItems', async () => [{ id: 1, name: 'Chicken Rice', stock: 3, baselineStock: 20 }]);
  const writes = [];
  t.mock.method(menuStore, 'setRemainingStock', async (id, stock) => { writes.push({ id, stock }); return { success: true }; });

  const sent = [];
  const bot = { async sendMessage(chatId, text) { sent.push(text); } };

  const handled = await admin.handleStageTwoStockInput(bot, 11, 11, '10', { mode: STATES.EDIT_STAGE2_STOCK, foodItemId: 1 }, 99);

  assert.equal(handled, true);
  assert.equal(writes.length, 0);
  assert.match(sent[0], /too low/);
  assert.match(sent[0], /17/);
});

test('a valid stage-2 total sets remaining = total - sold, for tonight only', async t => {
  const data = mockStore(t, { [stateStore.KEYS.stagePanel()]: { hallId: 2, adjust: {} } });
  t.mock.method(menuStore, 'getFoodItems', async () => [{ id: 1, name: 'Chicken Rice', stock: 3, baselineStock: 20 }]);
  t.mock.method(menuStore, 'getFoodItemsOrThrow', async () => [{ id: 1, name: 'Chicken Rice', stock: 8, baselineStock: 20 }]);
  const writes = [];
  t.mock.method(menuStore, 'setRemainingStock', async (id, stock) => { writes.push({ id, stock }); return { success: true }; });

  const bot = {
    async sendMessage() { return { message_id: 71 }; },
    async editMessageText() {},
    async deleteMessage() {},
  };

  await admin.handleStageTwoStockInput(bot, 11, 11, '25', { mode: STATES.EDIT_STAGE2_STOCK, foodItemId: 1 }, 99);

  assert.deepEqual(writes, [{ id: 1, stock: 8 }]); // 25 total - 17 sold
  assert.deepEqual(data[stateStore.KEYS.stagePanel()].adjust, { 1: 5 });
});

test('once stage 1 is posted, every outstanding reminder becomes a "posted" notice with no button', async t => {
  const data = mockStore(t);
  t.mock.method(googleSheets, 'getAdminIds', () => [11, 22]);

  const sentBot = { async sendMessage(chatId) { return { message_id: 1000 + chatId }; } };
  await admin.runOrderReminders(sentBot, at('2026-10-08T17:30'));
  assert.equal(data[stateStore.KEYS.orderReminders()].messages.length, 2);

  const edits = [];
  const bot = { async editMessageText(text, opts) { edits.push({ text, opts }); } };

  await admin.closeOrderReminders(bot, { postedBy: '@ali', cutoffLabel: '12:30 AM' });

  assert.deepEqual(edits.map(edit => edit.opts.chat_id), [11, 22]);
  assert.deepEqual(edits.map(edit => edit.opts.message_id), [1011, 1022]);
  assert.match(edits[0].text, /Tonight's orders have been posted by @ali/);
  assert.match(edits[0].text, /12:30 AM/);
  assert.deepEqual(edits[0].opts.reply_markup, { inline_keyboard: [] });
  assert.deepEqual(data[stateStore.KEYS.orderReminders()].messages, []);

  // Nothing left to close the second time.
  edits.length = 0;
  await admin.closeOrderReminders(bot, {});
  assert.equal(edits.length, 0);
});
