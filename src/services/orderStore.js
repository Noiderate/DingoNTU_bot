const repo = require('./orderRepository');
const { getSupabase, unwrap } = require('./supabase');
const { getServiceDayWindow } = require('./todaySheet');

/**
 * Adapter preserving the orderStore API that handlers already call, now backed
 * by Supabase instead of module-level objects.
 *
 * Every function here is ASYNC where the original was synchronous - order state
 * now lives in the database, which cannot be read synchronously. Call sites
 * have been updated with `await` and nothing else.
 *
 * The one deliberate exception is hall blocking: see loadBlockedHalls below.
 */

const STATUS = repo.STATUS;

/**
 * Convert a database row into the shape handlers expect.
 *
 * Keeps the original camelCase field names so admin.js and deliveryMode.js did
 * not need restructuring, and adds `code` (the human-readable order code) which
 * replaces the old restart-unstable integer id in customer-facing messages.
 */
function toOrder(row) {
  if (!row) {
    return null;
  }

  const customer = row.customers || {};
  const items = (row.order_items || []).map(item => ({
    id: item.food_sheet_row_id,
    name: item.item_name_snapshot,
    // Cents is authoritative; `price` is kept as a decimal for existing
    // display code that formats it.
    priceCents: item.unit_price_cents,
    price: item.unit_price_cents / 100,
    quantity: item.quantity,
    lineTotalCents: item.line_total_cents,
  }));

  return {
    id: row.id,
    code: row.order_code,
    status: row.status,
    createdAt: row.created_at,
    processedAt: row.admin_confirmed_at,

    userId: customer.telegram_user_id ? Number(customer.telegram_user_id) : null,
    userName: customer.first_name || 'Unknown',
    username: customer.telegram_username || null,
    phoneNumber: customer.phone_number || null,
    chatId: row.telegram_chat_id ? Number(row.telegram_chat_id) : null,

    hallName: row.hall_name_snapshot,
    hallSheetRowId: row.hall_sheet_row_id,

    items,
    totalCents: row.total_cents,
    total: row.total_cents / 100,

    paymentDueAt: row.payment_due_at,
    paidAt: row.paid_at,
    servedAt: row.served_at,
    rejectionReason: row.rejection_reason,

    raw: row,
  };
}

async function createPendingOrder({
  userId,
  userName,
  username,
  chatId,
  hallName,
  hallSheetRowId,
  items,
  totalCents,
  requiresAdminApproval = true,
}) {
  const customer = await repo.upsertCustomer({
    telegramUserId: userId,
    username,
    firstName: userName,
    lastName: null,
  });

  const order = await repo.createOrder({
    customerId: customer.id,
    telegramChatId: chatId,
    hallSheetRowId,
    hallName,
    items,
    totalCents,
    requiresAdminApproval,
  });

  return toOrder(order);
}

async function getPendingOrder(orderId) {
  return toOrder(await repo.getOrderById(orderId));
}

async function confirmPendingOrder(orderId, adminId) {
  const order = await repo.transitionOrderStatus(
    orderId,
    STATUS.PENDING_ADMIN_CONFIRMATION,
    STATUS.AWAITING_PAYMENT,
    'admin',
    'Admin confirmed order',
    { actorTelegramId: adminId }
  );

  return toOrder(order);
}

async function rejectPendingOrder(orderId, adminId, reason = 'Rejected by admin') {
  const order = await repo.transitionOrderStatus(
    orderId,
    STATUS.PENDING_ADMIN_CONFIRMATION,
    STATUS.REJECTED,
    'admin',
    reason,
    { actorTelegramId: adminId }
  );

  return toOrder(order);
}

/**
 * Previously wrote to an in-memory awaitingPaymentUsers map. That map is gone:
 * "is this customer expected to send a receipt" is now derived from order
 * status, which cannot drift out of sync with the order itself.
 */
async function getAwaitingPaymentOrder(telegramUserId) {
  return toOrder(await repo.getOrderAwaitingPaymentFor(telegramUserId));
}

async function getActiveOrders() {
  return (await repo.getActiveOrders()).map(toOrder);
}

async function getActiveOrdersByHall(hallName) {
  return (await repo.getActiveOrdersByHall(hallName)).map(toOrder);
}

// Both outcomes transition the order to the same SERVED status - "served in
// person" vs "left unattended" is a real operational difference worth telling
// the customer and recording, but not a different order lifecycle state, so
// it lives in the history reason rather than a new status enum value.
const SERVE_KIND_REASONS = {
  served: 'Served in person',
  dropped_off: 'Dropped off',
};

async function markOrderServed(orderId, adminId, { kind = 'served' } = {}) {
  const current = await repo.getOrderById(orderId);

  if (!current || !repo.ACTIVE_STATUSES.includes(current.status)) {
    return null;
  }

  const wasUnpaid = current.status !== STATUS.PAID;
  const baseReason = SERVE_KIND_REASONS[kind] || SERVE_KIND_REASONS.served;

  // A paid order can be served directly. An unpaid one is still marked
  // served because staff physically handed the food over; the payment state
  // remains visible in the order history and the sheet, and stays
  // reconcilable afterwards - see ALLOWED_TRANSITIONS[STATUS.SERVED].
  const order = await repo.transitionOrderStatus(
    orderId,
    current.status,
    STATUS.SERVED,
    'admin',
    wasUnpaid ? `${baseReason} while ${current.status}` : baseReason,
    { actorTelegramId: adminId }
  );

  if (!order) {
    return null;
  }

  return { ...toOrder(order), wasUnpaid, kind };
}


/**
 * How far a hall has gotten through tonight's serving, as a fraction.
 *
 * Scoped to the current service day (see todaySheet.getServiceDayWindow), not
 * "ever" - a hall's orders from a previous night are already resolved
 * (served/rejected/etc) and must not dilute tonight's count. A hall with no
 * servable orders at all reports fraction 1 (trivially "done"), so a hall
 * nobody ordered from doesn't stall the automatic get-ready/coming triggers
 * for the halls after it.
 */
async function getHallServeProgress(hallName) {
  const { start, end } = getServiceDayWindow();

  const orders = await repo.getOrdersForHallServeProgress(
    hallName,
    start.toUTC().toISO(),
    end.toUTC().toISO()
  );

  const total = orders.length;
  const served = orders.filter(order => order.status === STATUS.SERVED).length;

  return { total, served, fraction: total === 0 ? 1 : served / total };
}


// --- Hall blocking -----------------------------------------------------------

/**
 * Hall blocking used to be an in-memory array read synchronously from inside
 * .filter() and .every() predicates.
 *
 * Rather than making those predicates async - which would have meant
 * restructuring several handlers - the blocked set is loaded ONCE per request
 * with loadBlockedHalls() and the resulting object exposes synchronous
 * isBlocked(). Behaviour is identical; only the source of the data changed.
 */
async function loadBlockedHalls() {
  const supabase = getSupabase();
  const now = Date.now();

  const rows = unwrap(
    await supabase
      .from('halls_state')
      .select('hall_name, blocked_at, blocked_until')
      .order('blocked_at', { ascending: true }),
    'loadBlockedHalls'
  );

  // A null blocked_until means "until an admin resets it", which is exactly how
  // the bot behaves today. Expiry is evaluated here on read, never by a timer.
  const live = (rows || []).filter(
    row => !row.blocked_until || new Date(row.blocked_until).getTime() > now
  );

  const names = live.map(row => row.hall_name);
  const blocked = new Set(names);

  return {
    isBlocked: hallName => blocked.has(hallName),
    names,
    last: names.length ? names[names.length - 1] : null,
  };
}

async function blockHall(hallName, adminId = null) {
  if (!hallName) {
    return false;
  }

  const supabase = getSupabase();

  const rows = unwrap(
    await supabase
      .from('halls_state')
      .upsert(
        { hall_name: hallName, blocked_at: new Date().toISOString(), blocked_by: adminId },
        { onConflict: 'hall_name', ignoreDuplicates: true }
      )
      .select(),
    'blockHall'
  );

  // ignoreDuplicates means an already-blocked hall returns no rows, matching
  // the old behaviour of returning false when it was already in the array.
  return rows.length > 0;
}

async function revertLastBlockedHall() {
  const blocked = await loadBlockedHalls();

  if (!blocked.last) {
    return null;
  }

  const supabase = getSupabase();
  unwrap(
    await supabase.from('halls_state').delete().eq('hall_name', blocked.last),
    'revertLastBlockedHall'
  );

  return blocked.last;
}

async function clearBlockedHalls() {
  const supabase = getSupabase();

  unwrap(
    // Supabase requires a filter on delete; this matches every row.
    await supabase.from('halls_state').delete().neq('hall_name', ' '),
    'clearBlockedHalls'
  );
}

module.exports = {
  STATUS,
  toOrder,

  createPendingOrder,
  getPendingOrder,
  confirmPendingOrder,
  rejectPendingOrder,
  getAwaitingPaymentOrder,
  getActiveOrders,
  getActiveOrdersByHall,
  markOrderServed,
  getHallServeProgress,

  loadBlockedHalls,
  blockHall,
  revertLastBlockedHall,
  clearBlockedHalls,
};
