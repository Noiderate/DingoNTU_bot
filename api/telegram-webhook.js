const crypto = require('crypto');
const { waitUntil } = require('@vercel/functions');
const { handleUpdate } = require('../src/app');
const { getSupabase, unwrap, isUniqueViolation } = require('../src/services/supabase');
const { drainOutbox } = require('../src/services/sheetMirror');
const { getSheetSyncEnqueueCount } = require('../src/services/orderRepository');
const { config } = require('../src/config');
const { log } = require('../src/utils/logger');

/**
 * Telegram webhook.
 *
 * Replaces long polling, which cannot work on a platform with no always-on
 * process.
 *
 * Returns 200 for anything it has handled OR durably recorded, because a
 * non-2xx makes Telegram redeliver the same update - and a handler bug would
 * otherwise turn into an infinite redelivery loop. Non-2xx is reserved for
 * "we could not even record this", where a retry genuinely helps.
 */

/**
 * Constant-time comparison, so the secret cannot be recovered by measuring how
 * long a rejection takes.
 */
function secretMatches(received) {
  const expected = config.telegram.webhookSecret;

  if (!expected || !received) {
    return false;
  }

  const a = Buffer.from(String(received));
  const b = Buffer.from(expected);

  // timingSafeEqual throws on length mismatch, so compare lengths separately -
  // still constant-time with respect to the contents.
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Record an update_id, returning false if it has been seen before.
 *
 * Telegram redelivers when it does not receive a timely 2xx, so without this a
 * slow verification could cause the same receipt to be processed twice.
 */
async function claimUpdate(updateId) {
  const supabase = getSupabase();

  const result = await supabase
    .from('processed_updates')
    .insert({ update_id: updateId })
    .select();

  if (result.error) {
    if (isUniqueViolation(result.error)) {
      return false;
    }
    throw new Error(`claimUpdate: ${result.error.message}`);
  }

  return true;
}

async function readJsonBody(req) {
  if (req.body) {
    return typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  }

  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }

  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  if (!secretMatches(req.headers['x-telegram-bot-api-secret-token'])) {
    log('warn', 'webhook_bad_secret', {});
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  let update;
  try {
    update = await readJsonBody(req);
  } catch (error) {
    // Malformed body will never parse on a retry either.
    log('warn', 'webhook_bad_body', { error: error.message });
    res.status(200).json({ ok: true, ignored: 'unparseable' });
    return;
  }

  const updateId = update && update.update_id;

  if (!updateId) {
    res.status(200).json({ ok: true, ignored: 'no_update_id' });
    return;
  }

  // Before dedupe: if the database is unreachable we have recorded nothing, so
  // a retry is genuinely useful and Telegram should send this again.
  let isNew;
  try {
    isNew = await claimUpdate(updateId);
  } catch (error) {
    log('error', 'webhook_dedupe_failed', { update_id: updateId, error: error.message });
    res.status(503).json({ error: 'Storage unavailable' });
    return;
  }

  if (!isNew) {
    log('info', 'webhook_duplicate', { update_id: updateId });
    res.status(200).json({ ok: true, duplicate: true });
    return;
  }

  try {
    const enqueuedBefore = getSheetSyncEnqueueCount();
    const { deferred } = await handleUpdate(update);

    // Slow follow-up work runs after the response so Telegram is not kept
    // waiting on a Gemini round trip. Still bounded by maxDuration; anything
    // unfinished is recovered by the scheduled worker.
    for (const task of deferred) {
      waitUntil(task().catch(error => {
        log('error', 'deferred_task_failed', { update_id: updateId, error: error.message });
      }));
    }

    // Only when this update queued an order change: a menu tap or a hall
    // browse has nothing to push, and the scheduled tick still drains anything
    // else (retries, work queued by deferred tasks).
    if (getSheetSyncEnqueueCount() !== enqueuedBefore) {
      waitUntil(
        drainOutbox({ deadline: Date.now() + 20000, workerId: `webhook-${updateId}` })
          .catch(error => log('error', 'inline_outbox_drain_failed', { error: error.message }))
      );
    }

    res.status(200).json({ ok: true });
  } catch (error) {
    // The update is already recorded as processed, so retrying it would be a
    // loop rather than a fix. Log and acknowledge.
    log('error', 'webhook_handler_failed', {
      update_id: updateId,
      error: error.message,
      stack: error.stack,
    });
    res.status(200).json({ ok: false, handled: false });
  }
}

module.exports = handler;
// Exported for unit tests; the handler itself is the default export.
module.exports.secretMatches = secretMatches;
module.exports.claimUpdate = claimUpdate;
