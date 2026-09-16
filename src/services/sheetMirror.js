const { readFromSheet, writeToSheet, appendToSheet } = require('./googleSheets');
const { getSupabase, unwrap } = require('./supabase');
const { getOrderById } = require('./orderRepository');
const { formatSgt } = require('../utils/time');
const { centsToDecimalString } = require('../utils/money');
const { log } = require('../utils/logger');

/**
 * Mirrors Supabase orders into the Orders tab so kitchen staff keep the view
 * they already work from.
 *
 * Supabase is the source of truth. The sheet is written AFTER the database
 * commit, from an outbox, and a Sheets failure can never break ordering.
 *
 * Behaviour change from the original: the old code appended one row per admin
 * ACTION, so a single order produced several rows and an order nobody confirmed
 * produced none. Rows are now one-per-order, created when the order is placed
 * and updated in place thereafter.
 */

const SHEET = 'Orders';

// Columns A-K are exactly the original layout and keep their original headers.
// Everything new is appended to the right, so existing formulas, filters and
// muscle memory keep working.
const HEADERS = [
  'Timestamp',      // A - order placed
  'Order ID',       // B - now the order code; the old integer restarted at 1
  'Status',         // C - raw status enum, for formulas
  'User ID',        // D
  'User Name',      // E
  'Username',       // F
  'Hall',           // G
  'Items',          // H
  'Total',          // I
  'Admin ID',       // J - last admin to act
  'Processed At',   // K - when an admin confirmed
  // --- added by this upgrade ---
  'Order Code',          // L - the key rows are matched on
  'Order Status',        // M - human-readable label
  'Payment Status',      // N
  'Verification Outcome',// O
  'Verification Reasons',// P
  'Paid At (SGT)',       // Q
  'Last Updated (SGT)',  // R
];

const LAST_COLUMN = 'R';
const ORDER_CODE_COLUMN = 'L';

const STATUS_LABELS = {
  pending_admin_confirmation: 'Awaiting admin confirmation',
  awaiting_payment: 'Awaiting payment',
  verifying_payment: 'Verifying payment',
  payment_flagged: 'Payment under review',
  paid: 'Paid',
  served: 'Served / Delivered',
  rejected: 'Rejected',
  cancelled: 'Cancelled',
  expired: 'Expired',
};

const PAYMENT_STATUS = {
  pending_admin_confirmation: 'Not requested',
  awaiting_payment: 'Unpaid',
  verifying_payment: 'Checking',
  payment_flagged: 'Needs review',
  paid: 'Paid',
  served: 'Paid',
  rejected: 'Unpaid',
  cancelled: 'Unpaid',
  expired: 'Unpaid',
};

// Best-effort, per-instance only. Several Vercel instances each keep their own
// copy and staff can re-sort the sheet underneath us, so every hit is verified
// against the sheet before it is used and discarded when it does not match.
let rowCache = new Map();


/**
 * Create headers, or extend an existing sheet with the new right-hand columns.
 *
 * Handles the real-world case of a sheet that already has the original 11
 * headers: those are left untouched and only L:R are added.
 */
async function ensureHeaders() {
  const existing = (await readFromSheet(`${SHEET}!A1:${LAST_COLUMN}1`))[0] || [];

  if (existing.length === 0) {
    await writeToSheet(`${SHEET}!A1:${LAST_COLUMN}1`, [HEADERS]);
    log('info', 'sheet_headers_created', { columns: HEADERS.length });
    return;
  }

  if (existing.length < HEADERS.length) {
    const startColumn = String.fromCharCode('A'.charCodeAt(0) + existing.length);
    await writeToSheet(
      `${SHEET}!${startColumn}1:${LAST_COLUMN}1`,
      [HEADERS.slice(existing.length)]
    );
    log('info', 'sheet_headers_extended', { added: HEADERS.length - existing.length });
  }
}

/** Latest payment submission for an order, used for the verification columns. */
async function getLatestSubmission(orderId) {
  const supabase = getSupabase();

  const rows = unwrap(
    await supabase
      .from('payment_submissions')
      .select('outcome, outcome_reasons')
      .eq('order_id', orderId)
      .order('received_at', { ascending: false })
      .limit(1),
    'sheetMirror.getLatestSubmission'
  );

  return rows[0] || null;
}

function buildRow(order, submission) {
  const customer = order.customers || {};
  const items = (order.order_items || [])
    .map(item => `${item.item_name_snapshot} x${item.quantity}`)
    .join(', ');

  const lastHistoryAdmin = order.last_admin_telegram_id || '';

  return [
    formatSgt(order.created_at),                         // A
    order.order_code,                                    // B
    order.status,                                        // C
    customer.telegram_user_id || '',                     // D
    customer.first_name || '',                           // E
    customer.telegram_username ? `@${customer.telegram_username}` : '', // F
    order.hall_name_snapshot || '',                      // G
    items,                                               // H
    centsToDecimalString(order.total_cents),             // I
    lastHistoryAdmin,                                    // J
    formatSgt(order.admin_confirmed_at),                 // K
    order.order_code,                                    // L
    STATUS_LABELS[order.status] || order.status,         // M
    PAYMENT_STATUS[order.status] || '',                  // N
    submission ? submission.outcome : '',                // O
    submission ? (submission.outcome_reasons || []).join(', ') : '', // P
    formatSgt(order.paid_at),                            // Q
    formatSgt(order.updated_at),                         // R
  ];
}

/**
 * Locate an order's row by its code.
 *
 * Reads the Order Code column rather than trusting the cache blindly, because
 * staff sorting or deleting rows would otherwise make us overwrite the wrong
 * order's row - a silent and very confusing corruption.
 */
async function findRowByOrderCode(orderCode) {
  const cached = rowCache.get(orderCode);

  if (cached) {
    const check = await readFromSheet(`${SHEET}!${ORDER_CODE_COLUMN}${cached}`);
    if (check[0] && check[0][0] === orderCode) {
      return cached;
    }
    rowCache.delete(orderCode);
  }

  const column = await readFromSheet(`${SHEET}!${ORDER_CODE_COLUMN}2:${ORDER_CODE_COLUMN}`);

  for (let index = 0; index < column.length; index += 1) {
    const value = column[index] && column[index][0];
    if (value) {
      // Refresh the whole cache while we have the column in hand.
      rowCache.set(value, index + 2);
    }
  }

  return rowCache.get(orderCode) || null;
}

/**
 * Push one order's current state into the sheet.
 *
 * Appends when the order has no row yet, otherwise overwrites its row. Never
 * appends a second row for an order that already exists.
 */
async function syncOrder(orderId) {
  const order = await getOrderById(orderId);

  if (!order) {
    return { skipped: true };
  }

  await ensureHeaders();

  const submission = await getLatestSubmission(orderId);
  const values = buildRow(order, submission);

  const existingRow = await findRowByOrderCode(order.order_code);

  if (existingRow) {
    await writeToSheet(`${SHEET}!A${existingRow}:${LAST_COLUMN}${existingRow}`, [values]);
  } else {
    await appendToSheet(SHEET, values);
    // The appended row number is not returned, so drop the cache entry and let
    // the next lookup re-read the column.
    rowCache.delete(order.order_code);
  }

  const supabase = getSupabase();
  unwrap(
    await supabase
      .from('orders')
      .update({ sheet_synced_at: new Date().toISOString(), sheet_sync_error: null })
      .eq('id', orderId),
    'sheetMirror.markSynced'
  );

  return { synced: true, orderCode: order.order_code };
}


// --- Outbox drain ------------------------------------------------------------

const MAX_ATTEMPTS = 6;

function backoffMs(attempts) {
  // 2s, 4s, 8s ... capped at 5 minutes.
  return Math.min(2000 * 2 ** attempts, 5 * 60 * 1000);
}

/**
 * Drain queued sheet writes.
 *
 * Rows are claimed atomically so two concurrent drains - one from waitUntil,
 * one from the scheduler - cannot both write the same order.
 *
 * `deadline` keeps the drain inside the invocation's time budget; whatever is
 * left stays queued for the next run.
 */
async function drainOutbox({ limit = 20, deadline = Date.now() + 30000, workerId = 'inline' } = {}) {
  const supabase = getSupabase();
  const nowIso = new Date().toISOString();

  const candidates = unwrap(
    await supabase
      .from('sheet_sync_outbox')
      .select('*')
      .lte('next_attempt_at', nowIso)
      .or(`locked_until.is.null,locked_until.lt.${nowIso}`)
      .order('next_attempt_at', { ascending: true })
      .limit(limit),
    'sheetMirror.drainOutbox.candidates'
  );

  let drained = 0;
  let failed = 0;

  for (const candidate of candidates) {
    if (Date.now() > deadline) {
      break;
    }

    const claimed = unwrap(
      await supabase
        .from('sheet_sync_outbox')
        .update({
          locked_by: workerId,
          locked_until: new Date(Date.now() + 60000).toISOString(),
        })
        .eq('id', candidate.id)
        .or(`locked_until.is.null,locked_until.lt.${new Date().toISOString()}`)
        .select()
        .limit(1),
      'sheetMirror.drainOutbox.claim'
    );

    if (!claimed.length) {
      continue;
    }

    try {
      await syncOrder(candidate.order_id);

      unwrap(
        await supabase.from('sheet_sync_outbox').delete().eq('id', candidate.id),
        'sheetMirror.drainOutbox.delete'
      );
      drained += 1;
    } catch (error) {
      failed += 1;
      const attempts = candidate.attempts + 1;
      const givingUp = attempts >= MAX_ATTEMPTS;

      await supabase
        .from('sheet_sync_outbox')
        .update({
          attempts,
          locked_by: null,
          locked_until: null,
          next_attempt_at: new Date(Date.now() + backoffMs(attempts)).toISOString(),
          last_error: error.message,
        })
        .eq('id', candidate.id);

      if (givingUp) {
        // Surfaced in the Orders sheet troubleshooting query in MAINTENANCE.md.
        await supabase
          .from('orders')
          .update({ sheet_sync_error: error.message })
          .eq('id', candidate.order_id);
      }

      log('error', 'sheet_sync_failed', {
        order_id: candidate.order_id,
        attempts,
        giving_up: givingUp,
        error: error.message,
      });
    }
  }

  return { drained, failed, considered: candidates.length };
}

/**
 * Re-queue orders whose sheet row is behind the database.
 *
 * Catches anything lost to a crash between the DB commit and the outbox write.
 */
async function reconcile(limit = 50) {
  const supabase = getSupabase();

  const stale = unwrap(
    await supabase
      .from('orders')
      .select('id, updated_at, sheet_synced_at')
      .or('sheet_synced_at.is.null,sheet_sync_error.not.is.null')
      .order('updated_at', { ascending: true })
      .limit(limit),
    'sheetMirror.reconcile'
  );

  for (const order of stale) {
    await supabase.from('sheet_sync_outbox').upsert(
      { order_id: order.id, next_attempt_at: new Date().toISOString() },
      { onConflict: 'order_id' }
    );
  }

  return { requeued: stale.length };
}

function clearRowCache() {
  rowCache = new Map();
}

module.exports = {
  HEADERS,
  STATUS_LABELS,
  PAYMENT_STATUS,
  ensureHeaders,
  buildRow,
  findRowByOrderCode,
  syncOrder,
  drainOutbox,
  reconcile,
  clearRowCache,
};
