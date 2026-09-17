const { getFoodItems, updateFoodItemStocksBatch } = require('./googleSheets');
const repo = require('./orderRepository');
const orderStore = require('./orderStore');
const { formatCents } = require('../utils/money');
const { log } = require('../utils/logger');

/**
 * Downstream effects of an order decision, shared by every caller.
 *
 * The admin "Accept payment" button and the automatic verifier must do exactly
 * the same things, so both call markOrderPaid rather than each implementing the
 * steps. Duplicating them was how the two paths would quietly diverge - one
 * notifying the customer, the other forgetting to.
 */

const STATUS = repo.STATUS;

/**
 * Return an order's items to the FoodAndStock sheet.
 *
 * Matches on the sheet row id first and falls back to the item name, because
 * row ids shift whenever staff insert, delete or sort rows in the sheet - see
 * MAINTENANCE.md "Row-number-as-ID".
 */
async function restockOrder(order) {
  if (!order.items || !order.items.length) {
    return { success: true, restocked: 0 };
  }

  const liveItems = await getFoodItems();
  const updates = [];

  for (const orderedItem of order.items) {
    const liveItem = liveItems.find(item => item.id === orderedItem.id)
      || liveItems.find(item => item.name === orderedItem.name);

    if (!liveItem) {
      return {
        success: false,
        message: `Cannot restore stock for ${orderedItem.name} - it is no longer in the sheet`,
      };
    }

    updates.push({
      rowId: liveItem.id,
      newStock: (liveItem.stock || 0) + orderedItem.quantity,
    });
  }

  const result = await updateFoodItemStocksBatch(updates);

  return result.success
    ? { success: true, restocked: updates.length }
    : { success: false, message: result.message };
}

async function notify(bot, chatId, text) {
  try {
    await bot.sendMessage(chatId, text);
    return true;
  } catch (error) {
    // A customer who blocked the bot must not break the order flow.
    log('warn', 'customer_notify_failed', { error: error.message });
    return false;
  }
}

/**
 * Mark an order paid and run every downstream effect.
 *
 * `fromStatus` is passed explicitly so the update is conditional: if an admin
 * taps Accept at the same moment the verifier auto-approves, exactly one of
 * them transitions the order and the other gets null back.
 */
async function markOrderPaid(bot, order, { fromStatus, actor, actorTelegramId, reason }) {
  const updated = await repo.transitionOrderStatus(
    order.id,
    fromStatus,
    STATUS.PAID,
    actor,
    reason,
    { actorTelegramId }
  );

  if (!updated) {
    return null;
  }

  const paidOrder = orderStore.toOrder(updated);

  // Only reachable via an admin's manual accept (the automatic verifier
  // always transitions from VERIFYING_PAYMENT) - the order was already
  // served, so "being prepared" would be wrong.
  //
  // This is the customer's ONE confirmation message regardless of who/what
  // approved it - the automatic verifier used to send its own extra, near-
  // duplicate message on top of this one; that's now folded in here instead.
  const message = fromStatus === STATUS.SERVED
    ? `✅ Payment for Order ${paidOrder.code} has been confirmed. Thanks!`
    : `✅ Payment for Order ${paidOrder.code} confirmed - ${formatCents(paidOrder.totalCents)} received.\n\n`
      + `Your order is being prepared. 🍽️`;

  await notify(bot, paidOrder.chatId, message);

  log('info', 'order_paid', {
    order_code: paidOrder.code,
    actor,
    total_cents: paidOrder.totalCents,
  });

  return paidOrder;
}

/**
 * Reject an order, restore its stock and tell the customer.
 *
 * Stock is restored BEFORE the status transition: if restocking fails we must
 * not have already marked the order rejected, or the items would be lost from
 * inventory with no record of why.
 */
async function rejectOrderAndRestock(bot, order, {
  fromStatus,
  actor,
  actorTelegramId,
  reason,
  customerMessage,
}) {
  const restock = await restockOrder(order);

  if (!restock.success) {
    return { success: false, message: restock.message };
  }

  const updated = await repo.transitionOrderStatus(
    order.id,
    fromStatus,
    STATUS.REJECTED,
    actor,
    reason,
    { actorTelegramId }
  );

  if (!updated) {
    return { success: false, message: 'Order was already handled by someone else' };
  }

  const rejectedOrder = orderStore.toOrder(updated);

  await notify(
    bot,
    rejectedOrder.chatId,
    customerMessage
      || `❌ Your order ${rejectedOrder.code} was rejected. ${reason || ''}\n\nPlease restart your order by typing /start`
  );

  log('info', 'order_rejected', { order_code: rejectedOrder.code, actor, reason });

  return { success: true, order: rejectedOrder };
}

/**
 * Expire an unpaid order once its payment window has elapsed.
 *
 * Only ever called from the sweeper, and only for orders still in
 * awaiting_payment: an order already being verified is never expired, because
 * the deadline is judged on when the customer SENT their screenshot.
 */
async function expireOrder(bot, order) {
  const restock = await restockOrder(order);

  if (!restock.success) {
    log('error', 'expire_restock_failed', { order_code: order.code, error: restock.message });
    return null;
  }

  const updated = await repo.transitionOrderStatus(
    order.id,
    STATUS.AWAITING_PAYMENT,
    STATUS.EXPIRED,
    'system',
    'Payment window elapsed'
  );

  if (!updated) {
    return null;
  }

  const expiredOrder = orderStore.toOrder(updated);

  await notify(
    bot,
    expiredOrder.chatId,
    `⌛ Order ${expiredOrder.code} has expired because a payment receipt was not received in time.\n\n`
    + `The items have been returned to stock. Please create your order again by typing /start.\n\n`
    + `If you have already made payment, recreate the same order and submit the screenshot of that payment. You do not need to pay again.`
  );

  log('info', 'order_expired', { order_code: expiredOrder.code });

  return expiredOrder;
}

/** Shared summary block used in customer and admin messages. */
function buildOrderSummary(order) {
  const lines = order.items
    .map(item => `• ${item.name} x${item.quantity} = ${formatCents(item.lineTotalCents)}`)
    .join('\n');

  return `${lines || 'No items'}\n💰 Total: ${formatCents(order.totalCents)}`;
}

function describeCustomer(order) {
  return order.username ? `@${order.username}` : `${order.userName || 'Unknown'} (${order.userId})`;
}

module.exports = {
  restockOrder,
  markOrderPaid,
  rejectOrderAndRestock,
  expireOrder,
  buildOrderSummary,
  describeCustomer,
  notify,
};
