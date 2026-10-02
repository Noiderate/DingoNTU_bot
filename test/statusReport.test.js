const test = require('node:test');
const assert = require('node:assert/strict');
const {
  collectStatus, formatStatus, formatAge, scrub, isServiceHour,
  judgeTelegram, judgeGemini, judgeVerificationQueue, judgeSheetSync, judgeScheduler,
} = require('../src/services/statusReport');
const { REASONS } = require('../src/services/paymentRules');
const { recordTick } = require('../src/services/cronJobs');
const stateStore = require('../src/services/stateStore');
const { handleStatusCommand } = require('../src/handlers/admin');

/**
 * /status. Each rule that turns a raw reading into ok / warn / error is tested on
 * its own, because "everything green" is only worth something if the rules turn
 * red when they should.
 */

// 20:00 SGT, a service hour; 10:00 SGT, an off hour.
const IN_SERVICE = new Date('2026-10-02T12:00:00.000Z');
const OFF_HOURS = new Date('2026-10-02T02:00:00.000Z');
const ago = (now, ms) => new Date(now.getTime() - ms).toISOString();

// --- helpers ---------------------------------------------------------------------

test('ages read as seconds, minutes, then hours', () => {
  assert.equal(formatAge(40 * 1000), '40s');
  assert.equal(formatAge(5 * 60 * 1000), '5m');
  assert.equal(formatAge(3 * 60 * 60 * 1000), '3h');
});

test('anything that looks like a credential is stripped before it reaches a chat', () => {
  const raw = 'request to https://api.telegram.org/bot123456:ABC-def_ghi/getWebhookInfo failed, '
    + 'https://generativelanguage.googleapis.com/v1/models?key=AIzaSECRET&alt=json';
  const clean = scrub(raw);

  assert.ok(!clean.includes('ABC-def_ghi'));
  assert.ok(!clean.includes('AIzaSECRET'));
  assert.match(clean, /bot\[redacted\]/);
});

test('service hours are 15:00 to 03:59 SGT, matching the every-minute cron job', () => {
  assert.equal(isServiceHour(new Date('2026-10-02T07:00:00.000Z')), true);  // 15:00
  assert.equal(isServiceHour(new Date('2026-10-02T19:59:00.000Z')), true);  // 03:59
  assert.equal(isServiceHour(new Date('2026-10-02T20:00:00.000Z')), false); // 04:00
  assert.equal(isServiceHour(new Date('2026-10-02T06:59:00.000Z')), false); // 14:59
});

// --- Telegram --------------------------------------------------------------------

test('Telegram: no webhook is an error', () => {
  assert.equal(judgeTelegram({ url: '' }).level, 'error');
});

test('Telegram: a healthy webhook is ok', () => {
  assert.equal(judgeTelegram({ url: 'https://x', pending_update_count: 0 }, IN_SERVICE).level, 'ok');
});

test('Telegram: a delivery error in the last few minutes is a warning, an old one is ignored', () => {
  const recent = { url: 'https://x', last_error_date: IN_SERVICE.getTime() / 1000 - 60, last_error_message: 'Wrong response' };
  const old = { url: 'https://x', last_error_date: IN_SERVICE.getTime() / 1000 - 3 * 3600, last_error_message: 'Wrong response' };

  assert.equal(judgeTelegram(recent, IN_SERVICE).level, 'warn');
  assert.equal(judgeTelegram(old, IN_SERVICE).level, 'ok');
});

test('Telegram: a pile of waiting updates is a warning', () => {
  assert.equal(judgeTelegram({ url: 'https://x', pending_update_count: 50 }, IN_SERVICE).level, 'warn');
});

// --- Gemini ----------------------------------------------------------------------

test('Gemini: a missing key is an error', () => {
  assert.equal(judgeGemini({ configured: false, rows: [] }).level, 'error');
});

test('Gemini: no receipts recently is neutral, not green', () => {
  assert.equal(judgeGemini({ configured: true, rows: [] }).level, 'info');
});

test('Gemini: receipts that all went through are ok', () => {
  const rows = [{ outcome_reasons: [] }, { outcome_reasons: ['AMOUNT_MISMATCH'] }];
  assert.equal(judgeGemini({ configured: true, rows }).level, 'ok');
});

test('Gemini: a few failures warn, mostly failures is an error, and the cause is shown without secrets', () => {
  const failure = { outcome_reasons: [REASONS.GEMINI_VERIFICATION_FAILURE], last_error: 'quota exceeded ?key=SECRET123' };
  const fine = { outcome_reasons: [] };

  const few = judgeGemini({ configured: true, rows: [failure, fine, fine, fine] });
  const most = judgeGemini({ configured: true, rows: [failure, failure, fine] });

  assert.equal(few.level, 'warn');
  assert.equal(most.level, 'error');
  assert.match(few.text, /quota exceeded/);
  assert.ok(!few.text.includes('SECRET123'));
});

// --- Queues ----------------------------------------------------------------------

test('receipt queue: empty is ok, fresh work is ok, old work is a warning', () => {
  assert.equal(judgeVerificationQueue({ count: 0, oldestMs: 0 }).level, 'ok');
  assert.equal(judgeVerificationQueue({ count: 2, oldestMs: 20 * 1000 }).level, 'ok');
  assert.equal(judgeVerificationQueue({ count: 2, oldestMs: 10 * 60 * 1000 }).level, 'warn');
});

test('sheet sync: up to date, briefly behind, stuck, and orders that failed', () => {
  assert.deepEqual(judgeSheetSync({ pending: 0, oldestMs: 0, failedOrders: 0 }), { level: 'ok', text: 'up to date' });
  assert.equal(judgeSheetSync({ pending: 3, oldestMs: 10 * 1000, failedOrders: 0 }).level, 'ok');
  assert.equal(judgeSheetSync({ pending: 3, oldestMs: 10 * 60 * 1000, failedOrders: 0 }).level, 'warn');
  assert.equal(judgeSheetSync({ pending: 0, oldestMs: 0, failedOrders: 2 }).level, 'warn');
});

// --- Scheduler -------------------------------------------------------------------

test('scheduler: no tick on record is a warning', () => {
  assert.equal(judgeScheduler(null, IN_SERVICE).level, 'warn');
});

test('scheduler: a tick a minute ago is ok in service hours', () => {
  const last = { at: ago(IN_SERVICE, 60 * 1000), durationMs: 3000, failed: [] };
  assert.equal(judgeScheduler(last, IN_SERVICE).level, 'ok');
});

test('scheduler: ten minutes of silence in service hours means cron-job.org is off', () => {
  const last = { at: ago(IN_SERVICE, 10 * 60 * 1000), durationMs: 3000, failed: [] };
  assert.equal(judgeScheduler(last, IN_SERVICE).level, 'error');
});

test('scheduler: the same ten minutes is normal off hours, when it only runs hourly', () => {
  const last = { at: ago(OFF_HOURS, 10 * 60 * 1000), durationMs: 3000, failed: [] };
  assert.equal(judgeScheduler(last, OFF_HOURS).level, 'ok');
});

test('scheduler: but two hours of silence off hours is a problem', () => {
  const last = { at: ago(OFF_HOURS, 2 * 3600 * 1000), durationMs: 3000, failed: [] };
  assert.equal(judgeScheduler(last, OFF_HOURS).level, 'error');
});

test('scheduler: failed jobs and slow ticks are warnings, with the job names shown', () => {
  const failed = judgeScheduler({ at: ago(IN_SERVICE, 30 * 1000), durationMs: 3000, failed: ['sheet', 'menuSheet'] }, IN_SERVICE);
  const slow = judgeScheduler({ at: ago(IN_SERVICE, 30 * 1000), durationMs: 28 * 1000, failed: [] }, IN_SERVICE);

  assert.equal(failed.level, 'warn');
  assert.match(failed.text, /sheet, menuSheet/);
  assert.equal(slow.level, 'warn');
});

// --- Running the checks ----------------------------------------------------------

test('a check that throws or hangs is reported, and does not stop the others', async () => {
  const results = await collectStatus({}, {
    timeoutMs: 50,
    checks: [
      ['Fine', async () => ({ level: 'ok', text: 'fine' })],
      ['Broken', async () => { throw new Error('boom'); }],
      ['Hung', () => new Promise(() => {})],
    ],
  });

  assert.deepEqual(results.map(result => [result.label, result.level]), [
    ['Fine', 'ok'], ['Broken', 'error'], ['Hung', 'error'],
  ]);
  assert.equal(results[1].text, 'boom');
  assert.match(results[2].text, /no answer/);
});

test('an error from a check never carries a credential into the report', async () => {
  const results = await collectStatus({}, {
    checks: [['Telegram', async () => { throw new Error('failed: https://api.telegram.org/bot999:SECRET-token/getWebhookInfo'); }]],
  });

  assert.ok(!results[0].text.includes('SECRET-token'));
});

// --- The message -----------------------------------------------------------------

test('the report headline counts problems and warnings, or says all is well', () => {
  const ok = [{ label: 'A', level: 'ok', text: 'fine' }];
  const bad = [
    { label: 'A', level: 'error', text: 'down' },
    { label: 'B', level: 'warn', text: 'slow' },
    { label: 'C', level: 'warn', text: 'slow' },
  ];

  assert.match(formatStatus(ok, IN_SERVICE).split('\n')[0], /all systems OK/);
  assert.match(formatStatus(bad, IN_SERVICE).split('\n')[0], /1 problem, 2 warnings/);
});

test('each line carries its service name, icon and detail, in SGT', () => {
  const text = formatStatus([
    { label: 'Supabase', level: 'ok', text: 'reachable (80 ms)' },
    { label: 'Telegram', level: 'error', text: 'no webhook is set' },
  ], IN_SERVICE);

  assert.match(text, /Status at 20:00 SGT/);
  assert.match(text, /✅ Supabase: reachable \(80 ms\)/);
  assert.match(text, /❌ Telegram: no webhook is set/);
});

// --- The tick leaves its timestamp ------------------------------------------------

test('recordTick stores when the tick finished and which jobs failed', async t => {
  let saved = null;
  t.mock.method(stateStore, 'set', async (key, value) => { saved = { key, value }; });

  await recordTick({ payments: { processed: 0 }, sheet: { error: 'x' }, sweep: { expired: 0 } }, Date.now() - 1500);

  assert.equal(saved.key, stateStore.KEYS.cronLastTick());
  assert.deepEqual(saved.value.failed, ['sheet']);
  assert.ok(saved.value.durationMs >= 1500);
  assert.ok(saved.value.at);
});

test('recordTick never fails the tick it is recording', async t => {
  t.mock.method(console, 'warn', () => {});
  t.mock.method(stateStore, 'set', async () => { throw new Error('db down'); });

  await assert.doesNotReject(recordTick({}, Date.now()));
});

// --- The command -----------------------------------------------------------------

test('/status in a group is refused without running any check', async () => {
  const sent = [];
  const bot = {
    sendMessage: async (chatId, text) => { sent.push(text); },
    sendChatAction: async () => { throw new Error('must not start checking'); },
  };

  const handled = await handleStatusCommand(bot, { chat: { id: -100, type: 'supergroup' } });

  assert.equal(handled, true);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /private chat/);
});
