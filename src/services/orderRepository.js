const { getSupabase, unwrap, isUniqueViolation } = require('./supabase');
const { config } = require('../config');
const { sgtDateParts } = require('../utils/time');
const { OUTCOMES, REASONS } = require('./paymentRules');

/**
 * All Supabase access for customers, orders, order items and payment
 * submissions. Nothing else in the codebase talks to these tables directly.
 */

const STATUS = {
  PENDING_ADMIN_CONFIRMATION: 'pending_admin_confirmation',
  AWAITING_PAYMENT: 'awaiting_payment',
  VERIFYING_PAYMENT: 'verifying_payment',
  PAYMENT_FLAGGED: 'payment_flagged',
  PAID: 'paid',
  SERVED: 'served',
  REJECTED: 'rejected',
  CANCELLED: 'cancelled',
  EXPIRED: 'expired',
};

/**
 * Explicit allow-list of status changes.
 *
 * Every transition goes through transitionOrderStatus, and anything not listed
 * here is refused. This is what stops an admin tap and an automatic approval
 * from both "succeeding" on the same order and double-counting a payment.
 */
const ALLOWED_TRANSITIONS = {
  [STATUS.PENDING_ADMIN_CONFIRMATION]: [
    STATUS.AWAITING_PAYMENT,
    STATUS.REJECTED,
    STATUS.CANCELLED,
    STATUS.EXPIRED,
  ],
  [STATUS.AWAITING_PAYMENT]: [
    STATUS.VERIFYING_PAYMENT,
    STATUS.PAID,
    STATUS.PAYMENT_FLAGGED,
    STATUS.REJECTED,
    STATUS.CANCELLED,
    STATUS.EXPIRED,
    // Staff can hand over food before payment clears (see orderStore.markOrderServed).
    STATUS.SERVED,
  ],
  [STATUS.VERIFYING_PAYMENT]: [
    STATUS.PAID,
    STATUS.PAYMENT_FLAGGED,
    // A duplicate or unfinished transfer sends the customer back to try again.
    STATUS.AWAITING_PAYMENT,
    STATUS.REJECTED,
    STATUS.EXPIRED,
    STATUS.SERVED,
  ],
  [STATUS.PAYMENT_FLAGGED]: [
    STATUS.PAID,
    STATUS.REJECTED,
    STATUS.AWAITING_PAYMENT,
    STATUS.VERIFYING_PAYMENT,
    STATUS.SERVED,
  ],
  [STATUS.PAID]: [STATUS.SERVED, STATUS.REJECTED],
  // Terminal. An order served before payment cleared is reconciled with
  // recordPaymentOnServedOrder, which sets paid_at WITHOUT leaving SERVED -
  // moving it back to PAID made it active again, so it reappeared in the
  // hall's serve list waiting to be served a second time.
  [STATUS.SERVED]: [],
  [STATUS.REJECTED]: [],
  [STATUS.CANCELLED]: [],
  [STATUS.EXPIRED]: [],
};

/** Orders that Delivery Mode should list, matching what staff see today. */
const ACTIVE_STATUSES = [
  STATUS.AWAITING_PAYMENT,
  STATUS.VERIFYING_PAYMENT,
  STATUS.PAYMENT_FLAGGED,
  STATUS.PAID,
];

/**
 * Orders that genuinely represent food to be handed over at a hall - active
 * ones plus already-served ones. Used to measure serve progress for the
 * automatic get-ready/coming triggers: an order still pending admin
 * confirmation was never committed to, and a rejected/cancelled/expired one
 * never happened, so neither belongs in that denominator.
 */
const SERVABLE_STATUSES = [...ACTIVE_STATUSES, STATUS.SERVED];

// Customer is joined in because nearly every consumer needs the Telegram
// handle to address or label the order.
const ORDER_SELECT = '*, order_items(*), customers(*)';


// --- Customers ---------------------------------------------------------------

/**
 * `phoneNumber` is deliberately left out of the payload when not passed, not
 * defaulted to null - Supabase's upsert only overwrites the columns present
 * in the payload, so every OTHER call site (order creation touches this on
 * every order) leaves an already-collected phone number untouched.
 */
async function upsertCustomer({ telegramUserId, username, firstName, lastName, phoneNumber }) {
  const supabase = getSupabase();

  const payload = {
    telegram_user_id: telegramUserId,
    telegram_username: username || null,
    first_name: firstName || null,
    last_name: lastName || null,
    updated_at: new Date().toISOString(),
  };

  if (phoneNumber !== undefined) {
    payload.phone_number = phoneNumber;
  }

  const rows = unwrap(
    await supabase
      .from('customers')
      .upsert(payload, { onConflict: 'telegram_user_id' })
      .select()
      .limit(1),
    'upsertCustomer'
  );

  return rows[0];
}

async function getCustomerByTelegramId(telegramUserId) {
  const supabase = getSupabase();

  const rows = unwrap(
    await supabase
      .from('customers')
      .select('*')
      .eq('telegram_user_id', telegramUserId)
      .limit(1),
    'getCustomerByTelegramId'
  );

  return rows[0] || null;
}


// --- Orders ------------------------------------------------------------------

/**
 * Create an order and its line items.
 *
 * Called inside the stock-deduction lock, after the sheet has been decremented,
 * so a failure here must be followed by restocking - see the caller in
 * handlers/user.js.
 */
async function createOrder({
  customerId,
  telegramChatId,
  hallSheetRowId,
  hallName,
  items,
  totalCents,
  requiresAdminApproval = true,
}) {
  const supabase = getSupabase();
  const initialStatus = requiresAdminApproval
    ? STATUS.PENDING_ADMIN_CONFIRMATION
    : STATUS.AWAITING_PAYMENT;
  const paymentTiming = requiresAdminApproval ? {} : {
    payment_requested_at: new Date().toISOString(),
    payment_due_at: new Date(Date.now() + config.payment.windowMinutes * 60 * 1000).toISOString(),
  };

  const orderCode = unwrap(
    await supabase.rpc('allocate_order_code'),
    'allocateOrderCode'
  );

  const orderRows = unwrap(
    await supabase
      .from('orders')
      .insert({
        order_code: orderCode,
        customer_id: customerId,
        telegram_chat_id: telegramChatId,
        hall_sheet_row_id: hallSheetRowId,
        hall_name_snapshot: hallName,
        status: initialStatus,
        ...paymentTiming,
        subtotal_cents: totalCents,
        total_cents: totalCents,
      })
      .select()
      .limit(1),
    'createOrder'
  );

  const order = orderRows[0];

  if (items.length) {
    unwrap(
      await supabase.from('order_items').insert(
        items.map(item => ({
          order_id: order.id,
          food_sheet_row_id: item.foodSheetRowId,
          item_name_snapshot: item.name,
          category_snapshot: item.category || null,
          unit_price_cents: item.unitPriceCents,
          quantity: item.quantity,
          line_total_cents: item.unitPriceCents * item.quantity,
        }))
      ),
      'createOrderItems'
    );
  }

  await recordStatusHistory({
    orderId: order.id,
    fromStatus: null,
    toStatus: initialStatus,
    actor: 'customer',
    actorTelegramId: null,
    reason: 'Order placed',
  });

  await enqueueSheetSync(order.id);

  return getOrderById(order.id);
}

async function getOrderById(orderId) {
  const supabase = getSupabase();

  const rows = unwrap(
    await supabase.from('orders').select(ORDER_SELECT).eq('id', orderId).limit(1),
    'getOrderById'
  );

  return rows[0] || null;
}

async function getOrderByCode(orderCode) {
  const supabase = getSupabase();

  const rows = unwrap(
    await supabase.from('orders').select(ORDER_SELECT).eq('order_code', orderCode).limit(1),
    'getOrderByCode'
  );

  return rows[0] || null;
}

/**
 * The single entry point for changing an order's status.
 *
 * Race-safe by construction: the UPDATE carries `where status = fromStatus`, so
 * if another instance already moved the order the update matches zero rows and
 * this returns null. Callers must treat null as "someone else got there first"
 * rather than as an error.
 *
 * Also writes the audit history row and queues the Google Sheets mirror, so
 * those can never be forgotten at a call site.
 */
async function transitionOrderStatus(orderId, fromStatus, toStatus, actor, reason = null, {
  actorTelegramId = null,
  patch = {},
} = {}) {
  const allowed = ALLOWED_TRANSITIONS[fromStatus] || [];

  if (!allowed.includes(toStatus)) {
    throw new Error(
      `Illegal order transition ${fromStatus} -> ${toStatus}. ` +
      `Allowed from ${fromStatus}: ${allowed.join(', ') || '(none, terminal)'}`
    );
  }

  const supabase = getSupabase();
  const now = new Date().toISOString();

  const timestampPatch = {};
  if (toStatus === STATUS.AWAITING_PAYMENT && fromStatus === STATUS.PENDING_ADMIN_CONFIRMATION) {
    timestampPatch.admin_confirmed_at = now;
    timestampPatch.payment_requested_at = now;
    timestampPatch.payment_due_at = new Date(
      Date.now() + config.payment.windowMinutes * 60 * 1000
    ).toISOString();
  }
  if (toStatus === STATUS.PAID) timestampPatch.paid_at = now;
  if (toStatus === STATUS.SERVED) timestampPatch.served_at = now;
  if (toStatus === STATUS.REJECTED) {
    timestampPatch.rejected_at = now;
    timestampPatch.rejection_reason = reason;
  }
  if (toStatus === STATUS.EXPIRED) timestampPatch.rejection_reason = reason;

  const rows = unwrap(
    await supabase
      .from('orders')
      .update({ status: toStatus, ...timestampPatch, ...patch })
      .eq('id', orderId)
      .eq('status', fromStatus)
      .select(ORDER_SELECT),
    'transitionOrderStatus'
  );

  if (!rows.length) {
    return null;
  }

  await recordStatusHistory({
    orderId,
    fromStatus,
    toStatus,
    actor,
    actorTelegramId,
    reason,
  });

  await enqueueSheetSync(orderId);

  return rows[0];
}

/**
 * Record payment for an order that was served before its payment cleared.
 *
 * The order stays SERVED (the food has changed hands; it must not re-enter
 * the active set) and only gains paid_at. Conditional on paid_at still being
 * null, so two admins tapping "Mark Paid" at once confirm it exactly once.
 * Returns the updated row, or null if it was not an unpaid served order.
 */
async function recordPaymentOnServedOrder(orderId, actor, reason = null, { actorTelegramId = null } = {}) {
  const supabase = getSupabase();

  const rows = unwrap(
    await supabase
      .from('orders')
      .update({ paid_at: new Date().toISOString() })
      .eq('id', orderId)
      .eq('status', STATUS.SERVED)
      .is('paid_at', null)
      .select(ORDER_SELECT),
    'recordPaymentOnServedOrder'
  );

  if (!rows.length) {
    return null;
  }

  await recordStatusHistory({
    orderId,
    fromStatus: STATUS.SERVED,
    toStatus: STATUS.SERVED,
    actor,
    actorTelegramId,
    reason,
  });

  await enqueueSheetSync(orderId);

  return rows[0];
}

async function recordStatusHistory({ orderId, fromStatus, toStatus, actor, actorTelegramId, reason }) {
  const supabase = getSupabase();

  unwrap(
    await supabase.from('order_status_history').insert({
      order_id: orderId,
      from_status: fromStatus,
      to_status: toStatus,
      actor,
      actor_telegram_id: actorTelegramId,
      reason,
    }),
    'recordStatusHistory'
  );
}

async function getActiveOrders() {
  const supabase = getSupabase();

  return unwrap(
    await supabase
      .from('orders')
      .select(ORDER_SELECT)
      .in('status', ACTIVE_STATUSES)
      .order('created_at', { ascending: true }),
    'getActiveOrders'
  );
}

async function getActiveOrdersByHall(hallName) {
  const supabase = getSupabase();

  return unwrap(
    await supabase
      .from('orders')
      .select(ORDER_SELECT)
      .eq('hall_name_snapshot', hallName)
      .in('status', ACTIVE_STATUSES)
      .order('created_at', { ascending: true }),
    'getActiveOrdersByHall'
  );
}

/** One page of a customer's own order history, newest first. */
async function getOrdersForCustomer(telegramUserId, { limit = 5, offset = 0 } = {}) {
  const supabase = getSupabase();
  const customer = await getCustomerByTelegramId(telegramUserId);

  if (!customer) {
    return { orders: [], total: 0 };
  }

  const result = await supabase
    .from('orders')
    .select(ORDER_SELECT, { count: 'exact' })
    .eq('customer_id', customer.id)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  return {
    orders: unwrap(result, 'getOrdersForCustomer'),
    total: result.count || 0,
  };
}

/**
 * The order a customer's next screenshot should be attributed to.
 *
 * Replaces the old awaitingPaymentUsers map: derived from order status rather
 * than stored, so it cannot drift out of sync or be lost on a restart.
 */
async function getOrderAwaitingPaymentFor(telegramUserId) {
  const supabase = getSupabase();
  const customer = await getCustomerByTelegramId(telegramUserId);

  if (!customer) {
    return null;
  }

  const rows = unwrap(
    await supabase
      .from('orders')
      .select(ORDER_SELECT)
      .eq('customer_id', customer.id)
      .in('status', [STATUS.AWAITING_PAYMENT, STATUS.VERIFYING_PAYMENT, STATUS.PAYMENT_FLAGGED])
      .order('created_at', { ascending: false })
      .limit(1),
    'getOrderAwaitingPaymentFor'
  );

  return rows[0] || null;
}

/**
 * The orders that count toward a hall's serve progress tonight: created
 * within the given window and in a status that represents real food (see
 * SERVABLE_STATUSES). Only status is selected - this drives a threshold
 * calculation, not a display, so the fuller ORDER_SELECT join is unneeded.
 */
async function getOrdersForHallServeProgress(hallName, startIso, endIso) {
  const supabase = getSupabase();

  return unwrap(
    await supabase
      .from('orders')
      .select('status')
      .eq('hall_name_snapshot', hallName)
      .gte('created_at', startIso)
      .lt('created_at', endIso)
      .in('status', SERVABLE_STATUSES),
    'getOrdersForHallServeProgress'
  );
}

/** Orders whose payment window has elapsed, for the expiry sweeper. */
async function getExpiredUnpaidOrders(limit = 25) {
  const supabase = getSupabase();

  return unwrap(
    await supabase
      .from('orders')
      .select(ORDER_SELECT)
      .in('status', [STATUS.AWAITING_PAYMENT])
      .lt('payment_due_at', new Date().toISOString())
      .limit(limit),
    'getExpiredUnpaidOrders'
  );
}


// --- Sheet mirror outbox -----------------------------------------------------

/**
 * Queue an order for mirroring to the Orders tab.
 *
 * One pending row per order (enforced by a unique index): repeated changes
 * coalesce into a single push of the order's current state, which keeps the
 * Sheets API call count down.
 */
async function enqueueSheetSync(orderId) {
  const supabase = getSupabase();

  const result = await supabase.from('sheet_sync_outbox').upsert(
    {
      order_id: orderId,
      enqueued_at: new Date().toISOString(),
      next_attempt_at: new Date().toISOString(),
    },
    { onConflict: 'order_id' }
  );

  if (result.error && !isUniqueViolation(result.error)) {
    // Never fail the order because the mirror could not be queued; the
    // reconciler picks up anything whose sheet_synced_at is behind updated_at.
    console.error(JSON.stringify({
      event: 'sheet_sync_enqueue_failed',
      order_id: orderId,
      error: result.error.message,
    }));
  }
}


// --- Payment submissions -----------------------------------------------------

async function createPaymentSubmission(submission) {
  const supabase = getSupabase();

  const rows = unwrap(
    await supabase.from('payment_submissions').insert(submission).select().limit(1),
    'createPaymentSubmission'
  );

  return rows[0];
}

async function updatePaymentSubmission(submissionId, patch) {
  const supabase = getSupabase();

  const rows = unwrap(
    await supabase.from('payment_submissions').update(patch).eq('id', submissionId).select().limit(1),
    'updatePaymentSubmission'
  );

  return rows[0] || null;
}

async function getPaymentSubmission(submissionId) {
  const supabase = getSupabase();

  const rows = unwrap(
    await supabase.from('payment_submissions').select('*').eq('id', submissionId).limit(1),
    'getPaymentSubmission'
  );

  return rows[0] || null;
}

/**
 * Count of submissions currently held by a live lease, across all instances.
 *
 * This is how GEMINI_MAX_CONCURRENCY is enforced now that an in-memory token
 * bucket would only limit a single instance.
 */
async function countLiveVerificationLeases() {
  const supabase = getSupabase();

  const result = await supabase
    .from('payment_submissions')
    .select('id', { count: 'exact', head: true })
    .eq('outcome', 'processing')
    .gt('locked_until', new Date().toISOString());

  unwrap(result, 'countLiveVerificationLeases');
  return result.count || 0;
}

/**
 * Atomically claim one due submission for this worker.
 *
 * The UPDATE is conditional on the lease being absent or expired, so two
 * workers can never take the same job. A job whose function was killed simply
 * has its lease expire and becomes claimable again.
 *
 * A candidate can also lose this promotion to the `payment_submissions_*_claim_idx`
 * unique guards: a submission that was released back to `queued` after a
 * retryable failure keeps whatever image_sha256/reference_normalized it already
 * captured, so it can collide with another live submission that shares the same
 * receipt. That collision is a real duplicate, not a transient error - the
 * partial index is the source of truth here, not a pre-check - so it is
 * resolved as `duplicate_rejected` right away instead of being thrown. Left
 * unhandled, that throw would abort every other candidate in this batch and
 * reappear on the very next tick, since the poisoned row is still `queued`.
 *
 * Returns { submission, duplicates }: `submission` is the job claimed for
 * processing (or null if none was available), and `duplicates` lists any
 * candidates resolved this way so the caller can notify their customers.
 */
/**
 * The conditional-claim UPDATE shared by every caller that takes a lease on a
 * payment_submissions row: outcome/locked_by/locked_until/processing_started_at,
 * gated on the lease being absent or expired and the row still being live.
 * Re-checking the lease conditions inside the write (not just in whatever
 * read selected the candidate) is what makes two workers claiming the same
 * row impossible even when their reads raced.
 */
async function claimRow(supabase, { id, workerId, leaseMs, now, nowIso }) {
  return supabase
    .from('payment_submissions')
    .update({
      outcome: 'processing',
      locked_by: workerId,
      locked_until: new Date(now.getTime() + leaseMs).toISOString(),
      processing_started_at: nowIso,
    })
    .eq('id', id)
    .or(`locked_until.is.null,locked_until.lt.${nowIso}`)
    .in('outcome', ['queued', 'processing'])
    .select()
    .limit(1);
}

/**
 * Resolve a claim attempt that hit payment_submissions_*_claim_idx: the row
 * being claimed already carries a reference/image from an earlier
 * release-to-queued cycle that now collides with a different, live
 * submission. That collision is a real duplicate, not a transient error - the
 * partial index is the source of truth here, not a pre-check.
 */
async function resolveClaimConflict(candidate, nowIso) {
  const conflict = await findConflictingSubmission({
    referenceNormalized: candidate.reference_normalized,
    imageSha256: candidate.image_sha256,
  });

  const resolved = await updatePaymentSubmission(candidate.id, {
    outcome: OUTCOMES.DUPLICATE_REJECTED,
    outcome_reasons: [candidate.reference_normalized ? REASONS.DUPLICATE_REFERENCE : REASONS.DUPLICATE_IMAGE],
    duplicate_of_submission_id: conflict ? conflict.id : null,
    completed_at: nowIso,
    locked_by: null,
    locked_until: null,
  });

  return { submission: resolved, conflict };
}

async function claimNextSubmission(workerId, { leaseMs = 120000 } = {}) {
  const supabase = getSupabase();
  const now = new Date();
  const nowIso = now.toISOString();

  const candidates = unwrap(
    await supabase
      .from('payment_submissions')
      .select('id, image_sha256, reference_normalized')
      .in('outcome', ['queued', 'processing'])
      .lte('next_attempt_at', nowIso)
      .or(`locked_until.is.null,locked_until.lt.${nowIso}`)
      .order('next_attempt_at', { ascending: true })
      .limit(5),
    'claimNextSubmission.candidates'
  );

  const duplicates = [];

  for (const candidate of candidates) {
    const result = await claimRow(supabase, { id: candidate.id, workerId, leaseMs, now, nowIso });

    if (result.error) {
      if (!isUniqueViolation(result.error)) {
        unwrap(result, 'claimNextSubmission.claim');
      }

      duplicates.push(await resolveClaimConflict(candidate, nowIso));
      continue;
    }

    const rows = result.data || [];

    if (rows.length) {
      return { submission: rows[0], duplicates };
    }
  }

  return { submission: null, duplicates };
}

/**
 * Atomically claim one specific submission by id, for the synchronous
 * in-request verification path.
 *
 * Without this, a freshly-created submission (queued, unlocked, due
 * immediately per its defaults) is claimable by the scheduled worker's
 * claimNextSubmission() the instant it exists. The synchronous path used to
 * process it directly with no lease of its own, so a cron tick landing in
 * that window could run a second, fully independent verification pass on the
 * same submission concurrently - each hitting Gemini separately and
 * potentially disagreeing on the outcome. This shares claimRow/resolveClaimConflict
 * with claimNextSubmission so the two claim paths cannot drift apart.
 *
 * Returns the claimed row, or null if someone else (another invocation, the
 * scheduled worker, or - degenerately - a live duplicate) already holds it,
 * or has already resolved it as a duplicate. Either way the caller must skip
 * processing rather than duplicate that work.
 */
async function claimSubmissionById(submissionId, workerId, { leaseMs = 120000 } = {}) {
  const supabase = getSupabase();
  const now = new Date();
  const nowIso = now.toISOString();

  // image_sha256/reference_normalized are only ever populated after this
  // submission has been through at least one full processing attempt (they
  // are set well after claiming, once the receipt is downloaded and read).
  // The current sole caller always claims a just-created row, where both are
  // still null - so this select exists for correctness if that ever changes,
  // not because it is expected to find anything today.
  const [candidate] = unwrap(
    await supabase
      .from('payment_submissions')
      .select('id, image_sha256, reference_normalized')
      .eq('id', submissionId)
      .limit(1),
    'claimSubmissionById.candidate'
  );

  if (!candidate) {
    return null;
  }

  const result = await claimRow(supabase, { id: submissionId, workerId, leaseMs, now, nowIso });

  if (result.error) {
    if (!isUniqueViolation(result.error)) {
      unwrap(result, 'claimSubmissionById.claim');
    }

    await resolveClaimConflict(candidate, nowIso);
    return null;
  }

  const rows = result.data || [];
  return rows[0] || null;
}

/** Hand a job back to the queue for a later attempt. */
async function releaseSubmission(submissionId, { nextAttemptAt, lastError = null }) {
  return updatePaymentSubmission(submissionId, {
    outcome: 'queued',
    locked_by: null,
    locked_until: null,
    next_attempt_at: nextAttemptAt.toISOString(),
    last_error: lastError,
  });
}

/** How many unfinished-transfer replies this order has already had. */
async function countIncompleteAttempts(orderId) {
  const supabase = getSupabase();

  const result = await supabase
    .from('payment_submissions')
    .select('id', { count: 'exact', head: true })
    .eq('order_id', orderId)
    .eq('outcome', 'incomplete_transfer');

  unwrap(result, 'countIncompleteAttempts');
  return result.count || 0;
}

/**
 * Find the live submission already holding a reference or image hash.
 *
 * Used to explain a duplicate to the customer and to link the conflicting
 * record. The authoritative guard is the partial unique index, not this lookup:
 * this is only for reporting after a 23505.
 */
async function findConflictingSubmission({ referenceNormalized, imageSha256 }) {
  const supabase = getSupabase();
  const liveOutcomes = ['processing', 'auto_approved', 'flagged', 'manually_approved'];

  if (referenceNormalized) {
    const rows = unwrap(
      await supabase
        .from('payment_submissions')
        .select('*')
        .eq('reference_normalized', referenceNormalized)
        .in('outcome', liveOutcomes)
        .limit(1),
      'findConflictingSubmission.reference'
    );
    if (rows.length) return rows[0];
  }

  if (imageSha256) {
    const rows = unwrap(
      await supabase
        .from('payment_submissions')
        .select('*')
        .eq('image_sha256', imageSha256)
        .in('outcome', liveOutcomes)
        .limit(1),
      'findConflictingSubmission.image'
    );
    if (rows.length) return rows[0];
  }

  return null;
}


// --- Receipt evidence --------------------------------------------------------

function buildReceiptPath({ orderCode, submissionId, extension }) {
  const { year, month } = sgtDateParts();
  return `${year}/${month}/${orderCode}/${submissionId}.${extension}`;
}

async function uploadReceipt({ path, buffer, contentType }) {
  const supabase = getSupabase();

  const result = await supabase.storage
    .from(config.supabase.receiptsBucket)
    .upload(path, buffer, { contentType, upsert: true });

  if (result.error) {
    throw new Error(`uploadReceipt: ${result.error.message}`);
  }

  return path;
}

/**
 * Short-lived signed URL for an admin resolving a dispute.
 *
 * The bucket is private and must stay that way; this is the only way to view
 * evidence, and the link expires so it cannot be forwarded indefinitely.
 */
async function createReceiptSignedUrl(storagePath, expiresInSeconds = 600) {
  const supabase = getSupabase();

  const result = await supabase.storage
    .from(config.supabase.receiptsBucket)
    .createSignedUrl(storagePath, expiresInSeconds);

  if (result.error) {
    throw new Error(`createReceiptSignedUrl: ${result.error.message}`);
  }

  return result.data.signedUrl;
}

module.exports = {
  STATUS,
  ACTIVE_STATUSES,
  SERVABLE_STATUSES,
  ALLOWED_TRANSITIONS,

  upsertCustomer,
  getCustomerByTelegramId,

  createOrder,
  getOrderById,
  getOrderByCode,
  transitionOrderStatus,
  recordPaymentOnServedOrder,
  recordStatusHistory,
  getActiveOrders,
  getActiveOrdersByHall,
  getOrdersForHallServeProgress,
  getOrdersForCustomer,
  getOrderAwaitingPaymentFor,
  getExpiredUnpaidOrders,

  enqueueSheetSync,

  createPaymentSubmission,
  updatePaymentSubmission,
  getPaymentSubmission,
  countLiveVerificationLeases,
  claimNextSubmission,
  claimSubmissionById,
  releaseSubmission,
  countIncompleteAttempts,
  findConflictingSubmission,

  buildReceiptPath,
  uploadReceipt,
  createReceiptSignedUrl,
};
