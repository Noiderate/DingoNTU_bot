const crypto = require('crypto');
const { getBot } = require('../app');
const { getSupabase, unwrap } = require('./supabase');
const { processQueue } = require('./paymentVerifier');
const { drainOutbox, reconcile } = require('./sheetMirror');
const { refreshTodaySheet } = require('./todaySheet');
const { syncMenuToSheet } = require('./menuSheetSync');
const { refreshPreorderPost, refreshHallServeOrdersMessage, refreshDeliveryModeMenus } = require('../handlers/admin');
const { ensureAdminIdsLoaded } = require('./googleSheets');
const repo = require('./orderRepository');
const orderStore = require('./orderStore');
const orderActions = require('./orderActions');
const { config } = require('../config');
const { log } = require('../utils/logger');

/**
 * The scheduled background jobs.
 *
 * These are the safety net, not the main path: payment verification and sheet
 * syncing both normally run in-request via waitUntil. These endpoints recover
 * work whose function was killed, and pick up changes made directly in the
 * spreadsheet which the bot never saw.
 *
 * Every job must be idempotent and safe to run concurrently, because a
 * scheduler may retry or overlap calls.
 */

/**
 * Shared secret check for every /api/cron/* route.
 *
 * Constant-time so the token cannot be recovered by timing repeated requests.
 */
function isAuthorized(req) {
  const expected = config.worker.cronSecret;

  if (!expected) {
    return false;
  }

  const header = req.headers.authorization || '';
  const provided = header.startsWith('Bearer ') ? header.slice(7) : '';

  const a = Buffer.from(provided);
  const b = Buffer.from(expected);

  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Recover payment verifications whose function ended before they finished. */
async function runProcessPayments(deadline) {
  const bot = getBot();
  await ensureAdminIdsLoaded();

  return processQueue(bot, { deadline, workerId: `cron-${crypto.randomUUID().slice(0, 8)}` });
}

/** Push any order changes that have not reached the Orders tab yet. */
async function runDrainSheetOutbox(deadline) {
  const drained = await drainOutbox({ limit: 40, deadline, workerId: 'cron' });
  const reconciled = await reconcile(50);

  return { ...drained, ...reconciled };
}

/**
 * Rebuild the Today's Orders tab even when nothing drained this tick.
 *
 * drainOutbox already refreshes it after a real order change, which covers
 * the "live" case within seconds. This unconditional, once-a-minute call is
 * what flips the tab over at midnight (a quiet night has nothing to drain)
 * and catches anything the drain-triggered refresh missed.
 */
async function runRefreshTodaySheet() {
  return refreshTodaySheet();
}

/**
 * Copy the menu into the FoodAndStock tab if it changed.
 *
 * The tab is a one-way, read-only mirror of the database, so this is what keeps
 * it current after a stock change; it is free while nothing changed (see
 * menuSheetSync).
 */
async function runSyncMenuSheet() {
  return syncMenuToSheet();
}

/**
 * Re-render the preorder channel post.
 *
 * Catches hall edits made straight into the spreadsheet, which the bot's
 * event-driven refresh never sees. Skips the Telegram call entirely when the
 * rendered content is unchanged, so this is usually free.
 */
async function runRefreshPreorder() {
  const bot = getBot();
  return refreshPreorderPost(bot);
}

/**
 * Delete receipt images past RECEIPT_RETENTION_DAYS, for finished orders only.
 *
 * A small batch per run keeps each tick cheap; a backlog clears over the next
 * few minutes. When nothing is due this is a single small query.
 */
async function deleteOldReceipts() {
  const days = config.supabase.receiptRetentionDays;

  if (!days || days <= 0) {
    return 0;
  }

  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const due = await repo.getReceiptsPastRetention(cutoff, 100);
  const deleted = await repo.deleteStoredReceipts(due);

  if (deleted > 0) {
    log('info', 'receipts_deleted', { count: deleted, older_than_days: days });
  }

  return deleted;
}

/**
 * Expire overdue orders and prune bookkeeping tables.
 *
 * Only orders still in awaiting_payment are expired. An order already being
 * verified is left alone, because its deadline is judged on when the customer
 * sent their screenshot, not on when the check finishes.
 */
async function runSweep() {
  const bot = getBot();
  const supabase = getSupabase();
  const results = { expired: 0, pruned: {} };

  if (config.payment.expiryEnabled) {
    const overdue = await repo.getExpiredUnpaidOrders(25);

    for (const row of overdue) {
      const expired = await orderActions.expireOrder(bot, orderStore.toOrder(row));
      if (expired) {
        results.expired += 1;
        // The order was awaiting_payment (active), so it may be sitting in a
        // hall's cached "we are here" list - drop it now.
        await refreshHallServeOrdersMessage(bot, expired.hallName).catch(() => {});
      }
    }
  }

  // Dedupe records only need to outlive Telegram's retry window.
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  unwrap(
    await supabase.from('processed_updates').delete().lt('processed_at', dayAgo),
    'sweep.processed_updates'
  );

  const now = new Date().toISOString();
  unwrap(
    await supabase.from('bot_state').delete().not('expires_at', 'is', null).lt('expires_at', now),
    'sweep.bot_state'
  );
  unwrap(
    await supabase.from('carts').delete().not('expires_at', 'is', null).lt('expires_at', now),
    'sweep.carts'
  );
  // Abandoned leases from functions that were killed mid-critical-section.
  unwrap(
    await supabase.from('locks').delete().lt('expires_at', now),
    'sweep.locks'
  );

  // Its own failure must not stop the refreshes below.
  try {
    results.receiptsDeleted = await deleteOldReceipts();
  } catch (error) {
    results.receiptsDeleted = { error: error.message };
    log('error', 'receipt_cleanup_failed', { error: error.message });
  }

  if (results.expired > 0) {
    await refreshPreorderPost(bot).catch(() => {});
    // An expired order drops out of delivery mode's active list - without
    // this an admin with the menu open keeps seeing it until they navigate
    // away and back.
    await refreshDeliveryModeMenus(bot).catch(() => {});
  }

  return results;
}

/**
 * Run every job in sequence.
 *
 * This is what the scheduler calls: one cron entry instead of four, which also
 * means the regular database traffic keeps a free-tier Supabase project from
 * pausing for inactivity.
 *
 * Each job is isolated so one failure does not prevent the rest from running.
 */
async function runTick({ deadline = Date.now() + config.worker.timeBudgetMs } = {}) {
  const results = {};

  const jobs = [
    ['payments', () => runProcessPayments(deadline)],
    ['sheet', () => runDrainSheetOutbox(deadline)],
    ['todaySheet', () => runRefreshTodaySheet()],
    ['menuSheet', () => runSyncMenuSheet()],
    ['preorder', () => runRefreshPreorder()],
    ['sweep', () => runSweep()],
  ];

  for (const [name, job] of jobs) {
    try {
      results[name] = await job();
    } catch (error) {
      results[name] = { error: error.message };
      log('error', 'cron_job_failed', { job: name, error: error.message });
    }
  }

  return results;
}

/**
 * Wrap a job as a Vercel handler: check the secret, run it, report the result.
 */
function createCronHandler(name, job) {
  return async function handler(req, res) {
    if (!isAuthorized(req)) {
      log('warn', 'cron_unauthorized', { job: name });
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const startedAt = Date.now();
    const deadline = startedAt + config.worker.timeBudgetMs;

    try {
      const result = await job({ deadline });
      const durationMs = Date.now() - startedAt;

      log('info', 'cron_completed', { job: name, duration_ms: durationMs });
      res.status(200).json({ ok: true, job: name, duration_ms: durationMs, result });
    } catch (error) {
      log('error', 'cron_failed', { job: name, error: error.message });
      res.status(500).json({ ok: false, job: name, error: error.message });
    }
  };
}

module.exports = {
  isAuthorized,
  createCronHandler,
  runTick,
  runProcessPayments,
  runDrainSheetOutbox,
  runRefreshTodaySheet,
  runSyncMenuSheet,
  runRefreshPreorder,
  runSweep,
};
