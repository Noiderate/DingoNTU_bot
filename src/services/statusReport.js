const { DateTime } = require('luxon');
const { getSupabase } = require('./supabase');
const stateStore = require('./stateStore');
const googleSheets = require('./googleSheets');
const { REASONS } = require('./paymentRules');
const { config } = require('../config');
const { SGT } = require('../utils/time');

/**
 * The /status command: one message telling an admin whether each outside service
 * the bot depends on is working right now.
 *
 * Nothing here spends a metered quota except one single-cell Sheets read.
 * Gemini is judged from how the last hour of receipts actually went, not by
 * calling it, and the scheduler from the timestamp each tick leaves behind
 * (see cronJobs.recordTick), which is also how a cron-job.org job that has been
 * switched off shows up.
 *
 * Every check is isolated: one that fails or hangs is reported as a problem and
 * never stops the others.
 */

const CHECK_TIMEOUT_MS = 8000;
const SLOW_MS = 1500;

const QUEUE_STALE_MS = 5 * 60 * 1000;
const TELEGRAM_ERROR_RECENT_MS = 10 * 60 * 1000;
const TELEGRAM_PENDING_WARN = 20;
const GEMINI_WINDOW_MS = 60 * 60 * 1000;

// How old the last tick may be before it is a problem. This mirrors the
// cron-job.org schedule: every minute from 15:00 to 03:59 SGT, hourly otherwise.
// Change both together.
const TICK_STALE_IN_SERVICE_MS = 3 * 60 * 1000;
const TICK_STALE_OFF_HOURS_MS = 75 * 60 * 1000;
const TICK_SLOW_MS = 20 * 1000;

const ICONS = { ok: '✅', warn: '⚠️', error: '❌', info: 'ℹ️' };

// --- Small helpers -------------------------------------------------------------

function formatAge(ms) {
  const seconds = Math.max(0, Math.round(ms / 1000));

  if (seconds < 90) {
    return `${seconds}s`;
  }

  const minutes = Math.round(seconds / 60);

  if (minutes < 90) {
    return `${minutes}m`;
  }

  return `${Math.round(minutes / 60)}h`;
}

/**
 * Error text is about to be posted into a chat, so strip anything that looks
 * like a credential. A network error can carry the full request URL, and the
 * Telegram and Gemini URLs contain the bot token and the API key.
 */
function scrub(value) {
  return String(value || '')
    .replace(/bot\d+:[A-Za-z0-9_-]+/g, 'bot[redacted]')
    .replace(/([?&](?:key|token|apikey|api_key)=)[^&\s"']+/gi, '$1[redacted]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 140);
}

function isServiceHour(now) {
  const hour = DateTime.fromJSDate(now, { zone: SGT }).hour;
  return hour >= 15 || hour < 4;
}

function plural(count, word) {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

// --- Judging (pure, so each rule can be tested without any service) ------------

function judgeTelegram(info, now = new Date()) {
  if (!info || !info.url) {
    return { level: 'error', text: 'no webhook is set, so the bot receives nothing' };
  }

  const pending = info.pending_update_count || 0;
  const errorAt = info.last_error_date ? info.last_error_date * 1000 : 0;
  const recentError = errorAt && now.getTime() - errorAt < TELEGRAM_ERROR_RECENT_MS;

  if (recentError) {
    return {
      level: 'warn',
      text: `delivery error ${formatAge(now.getTime() - errorAt)} ago: ${scrub(info.last_error_message)}`,
    };
  }

  if (pending > TELEGRAM_PENDING_WARN) {
    return { level: 'warn', text: `${pending} updates are waiting, so the bot is falling behind` };
  }

  return { level: 'ok', text: `webhook set, ${pending} waiting` };
}

function judgeGemini({ configured, rows }) {
  if (!configured) {
    return { level: 'error', text: 'GEMINI_API_KEY is not set' };
  }

  if (rows.length === 0) {
    return { level: 'info', text: 'no receipts in the last hour, so nothing to judge it by' };
  }

  const failed = rows.filter(row => (row.outcome_reasons || []).includes(REASONS.GEMINI_VERIFICATION_FAILURE));

  if (failed.length === 0) {
    return { level: 'ok', text: `${plural(rows.length, 'receipt')} checked in the last hour, none failed` };
  }

  const detail = failed.find(row => row.last_error);
  const suffix = detail ? ` (${scrub(detail.last_error)})` : '';

  return {
    level: failed.length * 2 >= rows.length ? 'error' : 'warn',
    text: `${failed.length} of ${plural(rows.length, 'receipt')} in the last hour could not be read by Gemini${suffix}`,
  };
}

function judgeVerificationQueue({ count, oldestMs }) {
  if (count === 0) {
    return { level: 'ok', text: 'nothing waiting' };
  }

  if (oldestMs > QUEUE_STALE_MS) {
    return { level: 'warn', text: `${count} waiting, the oldest for ${formatAge(oldestMs)}` };
  }

  return { level: 'ok', text: `${count} being checked` };
}

function judgeSheetSync({ pending, oldestMs, failedOrders }) {
  const parts = [];
  let level = 'ok';

  if (pending > 0) {
    parts.push(`${pending} waiting to sync (oldest ${formatAge(oldestMs)})`);

    if (oldestMs > QUEUE_STALE_MS) {
      level = 'warn';
    }
  }

  if (failedOrders > 0) {
    parts.push(`${plural(failedOrders, 'order')} failed to sync`);
    level = 'warn';
  }

  return { level, text: parts.length ? parts.join(', ') : 'up to date' };
}

function judgeScheduler(lastTick, now = new Date()) {
  if (!lastTick || !lastTick.at) {
    return {
      level: 'warn',
      text: 'no tick recorded yet: cron-job.org is not reaching the bot, or this is the first run since the last deploy',
    };
  }

  const ageMs = now.getTime() - new Date(lastTick.at).getTime();
  const limit = isServiceHour(now) ? TICK_STALE_IN_SERVICE_MS : TICK_STALE_OFF_HOURS_MS;

  if (ageMs > limit) {
    return {
      level: 'error',
      text: `last tick ${formatAge(ageMs)} ago: cron-job.org may be switched off or failing`,
    };
  }

  const failed = lastTick.failed || [];

  if (failed.length > 0) {
    return { level: 'warn', text: `last tick ${formatAge(ageMs)} ago, but these jobs failed: ${failed.join(', ')}` };
  }

  if (lastTick.durationMs > TICK_SLOW_MS) {
    return {
      level: 'warn',
      text: `last tick ${formatAge(ageMs)} ago but slow (${formatAge(lastTick.durationMs)}); cron-job.org gives up at 30s`,
    };
  }

  return { level: 'ok', text: `last tick ${formatAge(ageMs)} ago (took ${formatAge(lastTick.durationMs || 0)})` };
}

// --- The checks (each talks to one service) ------------------------------------

async function checkSupabase() {
  const startedAt = Date.now();

  const result = await getSupabase()
    .from('bot_state')
    .select('key', { count: 'exact', head: true })
    .limit(1);

  if (result.error) {
    throw new Error(result.error.message);
  }

  const ms = Date.now() - startedAt;
  return { level: ms > SLOW_MS ? 'warn' : 'ok', text: `reachable (${ms} ms)` };
}

function makeTelegramCheck(bot) {
  return async function checkTelegram() {
    return judgeTelegram(await bot.getWebHookInfo());
  };
}

async function checkSheets() {
  const startedAt = Date.now();

  try {
    await googleSheets.readFromSheetOrThrow('Settings!A1');
  } catch (error) {
    const quota = /429|quota|rate.?limit|too many/i.test(error.message);
    throw new Error(quota ? `${error.message} - probably over the Sheets quota` : error.message);
  }

  const ms = Date.now() - startedAt;
  return { level: ms > SLOW_MS ? 'warn' : 'ok', text: `reachable (${ms} ms)` };
}

async function checkGemini() {
  const since = new Date(Date.now() - GEMINI_WINDOW_MS).toISOString();

  const result = await getSupabase()
    .from('payment_submissions')
    .select('outcome_reasons, last_error')
    .gte('received_at', since)
    .limit(500);

  if (result.error) {
    throw new Error(result.error.message);
  }

  return judgeGemini({
    configured: Boolean(config.gemini.apiKey),
    rows: result.data || [],
  });
}

async function checkVerificationQueue() {
  const result = await getSupabase()
    .from('payment_submissions')
    .select('received_at')
    .in('outcome', ['queued', 'processing'])
    .order('received_at', { ascending: true })
    .limit(200);

  if (result.error) {
    throw new Error(result.error.message);
  }

  const rows = result.data || [];

  return judgeVerificationQueue({
    count: rows.length,
    oldestMs: rows.length ? Date.now() - new Date(rows[0].received_at).getTime() : 0,
  });
}

async function checkSheetSync() {
  const supabase = getSupabase();

  const [outbox, failed] = await Promise.all([
    supabase.from('sheet_sync_outbox').select('enqueued_at', { count: 'exact' })
      .order('enqueued_at', { ascending: true }).limit(1),
    supabase.from('orders').select('id', { count: 'exact', head: true })
      .not('sheet_sync_error', 'is', null),
  ]);

  for (const result of [outbox, failed]) {
    if (result.error) {
      throw new Error(result.error.message);
    }
  }

  const oldest = (outbox.data || [])[0];

  return judgeSheetSync({
    pending: outbox.count || 0,
    oldestMs: oldest ? Date.now() - new Date(oldest.enqueued_at).getTime() : 0,
    failedOrders: failed.count || 0,
  });
}

async function checkScheduler() {
  return judgeScheduler(await stateStore.get(stateStore.KEYS.cronLastTick(), null));
}

function defaultChecks(bot) {
  return [
    ['Supabase', checkSupabase],
    ['Telegram', makeTelegramCheck(bot)],
    ['Google Sheets', checkSheets],
    ['Gemini', checkGemini],
    ['Scheduler', checkScheduler],
    ['Sheet sync', checkSheetSync],
    ['Receipt queue', checkVerificationQueue],
  ];
}

// --- Running and formatting ----------------------------------------------------

async function runCheck([label, check], timeoutMs) {
  let timer;

  try {
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`no answer within ${timeoutMs / 1000}s`)), timeoutMs);
    });

    return { label, ...(await Promise.race([check(), timeout])) };
  } catch (error) {
    return { label, level: 'error', text: scrub(error.message) || 'check failed' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Run every check at once and return their results in order.
 * `checks` and `timeoutMs` exist so tests can supply their own.
 */
async function collectStatus(bot, { checks = defaultChecks(bot), timeoutMs = CHECK_TIMEOUT_MS } = {}) {
  return Promise.all(checks.map(check => runCheck(check, timeoutMs)));
}

function deployLine() {
  const sha = process.env.VERCEL_GIT_COMMIT_SHA;
  const region = process.env.VERCEL_REGION;

  if (!sha && !region) {
    return 'Deploy: local run';
  }

  return `Deploy: ${[sha && sha.slice(0, 7), region].filter(Boolean).join(' · ')}`;
}

function formatStatus(results, now = new Date()) {
  const problems = results.filter(result => result.level === 'error').length;
  const warnings = results.filter(result => result.level === 'warn').length;

  let summary = 'all systems OK';
  if (problems || warnings) {
    summary = [problems && plural(problems, 'problem'), warnings && plural(warnings, 'warning')]
      .filter(Boolean)
      .join(', ');
  }

  const time = DateTime.fromJSDate(now, { zone: SGT }).toFormat('HH:mm');
  const lines = results.map(result => `${ICONS[result.level] || ICONS.info} ${result.label}: ${result.text}`);

  return [`🩺 Status at ${time} SGT: ${summary}`, '', ...lines, '', deployLine()].join('\n');
}

module.exports = {
  collectStatus,
  formatStatus,
  formatAge,
  scrub,
  isServiceHour,
  judgeTelegram,
  judgeGemini,
  judgeVerificationQueue,
  judgeSheetSync,
  judgeScheduler,
};
